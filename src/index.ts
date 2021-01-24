import unionize, { ofType } from "unionize";
import { addChangeHandler, Atom, deref, removeChangeHandler, swap } from "@libre/atom";


export type BackoffFn = (attempt: number, randSeed: number) => number;

export type Context = {
  url: string;
  reconnectAttempt: number;
  randSeed: number;
  pingTimeoutMillis: number;
  pongTimeoutMillis: number;
  backoffFn: BackoffFn;
};

export const States = unionize({
  INITIAL: ofType<Context>(),
  CONNECTING: ofType<Context>(),
  OPEN: ofType<Context>(),
  CLOSED: ofType<Context>(),
  RECONNECTING: ofType<Context>(),
});

export type State = typeof States._Union;

export const Actions = unionize({
  CONNECT: {},
  OPEN: {},
  HEARTBEAT: {},
  PING_TIMEOUT: {},
  PONG_TIMEOUT: {},
  CLOSE: {},
  RECONNECT: {},
});

export type Action = typeof Actions._Union;

export type TimeoutKey = "ping" | "pong" | "connect";

export const Effects = unionize({
  CONNECT_WS: ofType<{
    url: string;
    onOpen: Action;
    onClose: Action;
    onPongMessage: Action;
  }>(),
  SCHEDULE_TIMEOUT: ofType<{
    key: TimeoutKey;
    timeoutMillis: number;
    onTimeout: Action;
  }>(),
  // eslint-disable-next-line @typescript-eslint/ban-types
  SEND_PING: ofType<{}>(),
  CLEAR_TIMEOUT: ofType<{ key: TimeoutKey }>(),
  TRIGGER_ACTION: ofType<{ action: Action }>(),
});

export type Effect = typeof Effects._Union;

export const calcBackoff = (
  attempt: number,
  randSeed: number,
  maxVal = 30000
): number => {
  if (attempt === 0) {
    return 0;
  }
  return Math.min(maxVal, attempt ** 2 * 1000) + 2000 * randSeed;
};

const connect = (state: State): [State, Effect[]] => [
  States.CONNECTING(state),
  [
    Effects.CLEAR_TIMEOUT({ key: "connect" }),
    Effects.CONNECT_WS({
      url: state.url,
      onOpen: Actions.OPEN(),
      onClose: Actions.CLOSE(),
      onPongMessage: Actions.HEARTBEAT(),
    }),
  ],
];

const clearTimeoutEffect = (key: TimeoutKey) => Effects.CLEAR_TIMEOUT({ key });

const clearAllTimeoutsEffects = [
  clearTimeoutEffect("connect"),
  clearTimeoutEffect("ping"),
  clearTimeoutEffect("pong"),
];

const scheduleConnect = (state: State) =>
  Effects.SCHEDULE_TIMEOUT({
    key: "connect",
    timeoutMillis: state.backoffFn(state.reconnectAttempt + 1, state.randSeed),
    onTimeout: Actions.CONNECT(),
  });

const schedulePing = (state: State) =>
  Effects.SCHEDULE_TIMEOUT({
    key: "ping",
    timeoutMillis: state.pingTimeoutMillis,
    onTimeout: Actions.PING_TIMEOUT(),
  });

const waitForPong = (state: State) =>
  Effects.SCHEDULE_TIMEOUT({
    key: "pong",
    timeoutMillis: state.pongTimeoutMillis,
    onTimeout: Actions.PONG_TIMEOUT(),
  });

export const update = (action: Action, state: State): [State, Effect[]] =>
  States.match(state, {
    INITIAL: () =>
      Actions.match(action, {
        CONNECT: () => connect(state),
        default: () => [state, []],
      }),

    CONNECTING: () =>
      Actions.match(action, {
        OPEN: () => [
          States.OPEN({ ...state, reconnectAttempt: 0 }),
          [schedulePing(state)],
        ],
        CLOSE: () => [States.CLOSED(state), clearAllTimeoutsEffects],
        default: () => [state, []],
      }),

    OPEN: () =>
      Actions.match(action, {
        PING_TIMEOUT: () => [
          state,
          [
            Effects.CLEAR_TIMEOUT({ key: "ping" }),
            Effects.SEND_PING(),
            waitForPong(state),
          ],
        ],
        PONG_TIMEOUT: () => [
          state,
          [
            Effects.TRIGGER_ACTION({ action: Actions.CLOSE() }),
            Effects.TRIGGER_ACTION({ action: Actions.RECONNECT() }),
          ],
        ],
        HEARTBEAT: () => [
          state,
          [
            Effects.CLEAR_TIMEOUT({ key: "ping" }),
            Effects.CLEAR_TIMEOUT({ key: "pong" }),
            schedulePing(state),
          ],
        ],
        CLOSE: () => [States.CLOSED(state), clearAllTimeoutsEffects],
        default: () => [state, []],
      }),

    CLOSED: () =>
      Actions.match(action, {
        RECONNECT: () => [
          States.RECONNECTING({
            ...state,
            reconnectAttempt: state.reconnectAttempt + 1,
          }),
          [scheduleConnect(state)],
        ],
        default: () => [state, []],
      }),

    RECONNECTING: () =>
      Actions.match(action, {
        CONNECT: () => connect(state),
        default: () => [state, []],
      }),
  });

export type Config = Pick<
  Context,
  "url" | "pingTimeoutMillis" | "pongTimeoutMillis" | "backoffFn"
  > & {
  pingMsg?: string,
  onMessage: (msg: string) => void,
  onStateChange?: (states: { previous: State, current: State }) => void
};

export type WsMachine = {
  connect: () => void;
  currentState: () => State;
  disconnect: () => void;
};

// Defined to handle node vs browser in dev/test vs prod
type TTimeout = ReturnType<typeof setTimeout>;

export const wsMachine = (config: Config): WsMachine => {
  let ws: WebSocket | undefined;
  const wsState = Atom.of(States.INITIAL({ ...config, reconnectAttempt: 0, randSeed: Math.random() }));
  const timeouts: Map<TimeoutKey, TTimeout> = new Map();

  type WsMessageKeys = keyof WebSocketEventMap;
  const wsHandlers: Map<WsMessageKeys, (ev: any) => void> = new Map();

  const addEventListener = (
    webSocket: WebSocket,
    type: WsMessageKeys,
    handler: (ev: any) => void
  ) => {
    webSocket.addEventListener(type, handler);
    wsHandlers.set(type, handler);
  };

  const removeEventListeners = (webSocket: WebSocket) => {
    wsHandlers.forEach((h, k) => {
      webSocket.removeEventListener(k, h);
    });
  };

  const nukeTimeout = (k: TimeoutKey) => {
    const t = timeouts.get(k);
    if (t) {
      clearTimeout(t);
    }
  };

  const clearTimeouts = () => {
    timeouts.forEach((v, k) => {
      nukeTimeout(k);
    });
  };

  const transition = (a: Action) => {
    const [newState, effects] = update(a, deref(wsState));
    swap(wsState, () => newState);
    handleEffects(effects);
  };

  const handleEffect = (effect: Effect) => {
    Effects.match(effect, {
      CONNECT_WS: (conn) => {
        if (ws) {
          removeEventListeners(ws);
          clearTimeouts();
          ws.close();
        }

        ws = new WebSocket(conn.url);

        const onOpen = () => transition(conn.onOpen);
        addEventListener(ws, "open", onOpen);

        const onClose = () => {
          // console.warn("Connection closed, initiating reconnect with backoff");
          transition(conn.onClose);
          transition(Actions.RECONNECT());
        };
        addEventListener(ws, "close", onClose);

        const onMessage = (ev: MessageEvent) => {
          const msg = ev.data;
          if (msg !== "pong") {
            config.onMessage(msg);
          }
          transition(conn.onPongMessage);
        };
        addEventListener(ws, "message", onMessage);
      },

      SCHEDULE_TIMEOUT: (t) => {
        timeouts.set(
          t.key,
          setTimeout(() => transition(t.onTimeout), t.timeoutMillis)
        );
      },

      SEND_PING: () => {
        if (ws) {
          ws.send(config.pingMsg ?? "ping");
        }
      },

      CLEAR_TIMEOUT: (t) => nukeTimeout(t.key),

      TRIGGER_ACTION: (a) => transition(a.action),
    });
  };

  const handleEffects = (effects: Effect[]) => {
    effects.forEach((e) => {
      handleEffect(e);
    });
  };

  if(config.onStateChange) {
    addChangeHandler(wsState, "wsStateHandler", config.onStateChange)
  }


  return {
    connect: () => transition(Actions.CONNECT()),
    currentState: () => deref(wsState),
    disconnect: () => {
      removeChangeHandler(wsState, "wsStateHandler");
      if (ws) {
        removeEventListeners(ws);
        clearTimeouts();
        swap(wsState, (currState) =>
          States.INITIAL({ ...currState, reconnectAttempt: 0 })
        );
        ws.close();
      }
    },
  };
};