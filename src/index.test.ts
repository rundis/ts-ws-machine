import {
  Actions,
  calcBackoff,
  Context,
  Effects,
  States,
  update,
  WSMachine,
  wsMachine,
} from "./index";
import WS from "jest-websocket-mock";

describe(`verify exponential backoff`, () => {
  test.each`
    attempt | expected
    ${0}    | ${0}
    ${1}    | ${1000}
    ${2}    | ${4000}
    ${4}    | ${16000}
    ${5}    | ${25000}
    ${6}    | ${30000}
  `("attempt $attempt gives $expected", ({ attempt, expected }) => {
    expect(calcBackoff(attempt, 0)).toBe(expected);
  });

  test(`exponential with random seed works`, () => {
    expect(calcBackoff(1, 0.5)).toBe(2000);
  });

  test(`exponential with random seed and overridden max works`, () => {
    expect(calcBackoff(6, 0.5, 60000)).toBe(37000);
  });
});

describe("verify all update transitions", () => {
  // actions
  const [
    connect,
    open,
    heartbeat,
    pingtimeout,
    pongtimeout,
    close,
    reconnect,
  ] = [
    Actions.CONNECT(),
    Actions.OPEN(),
    Actions.HEARTBEAT(),
    Actions.PING_TIMEOUT(),
    Actions.PONG_TIMEOUT(),
    Actions.CLOSE(),
    Actions.RECONNECT(),
  ];

  const initialContext: Context = {
    url: "ws",
    reconnectAttempt: 0,
    randSeed: 0,
    pingTimeoutMillis: 1,
    pongTimeoutMillis: 1,
    backoffFn: calcBackoff,
  };

  // states
  const initial = States.INITIAL(initialContext);
  const connecting = States.CONNECTING(initialContext);
  const opened = States.OPEN(initialContext);
  const closed = States.CLOSED(initialContext);
  const reconnecting = States.RECONNECTING({
    ...initialContext,
    reconnectAttempt: 1,
  });
  const connecting1 = States.CONNECTING({
    ...initialContext,
    reconnectAttempt: 1,
  });

  // effects
  const fCon = Effects.CONNECT_WS({
    url: initialContext.url,
    onOpen: Actions.OPEN(),
    onClose: Actions.CLOSE(),
    onPongMessage: Actions.HEARTBEAT(),
  });

  const fClearCon = Effects.CLEAR_TIMEOUT({ key: "connect" });
  const fClearPing = Effects.CLEAR_TIMEOUT({ key: "ping" });
  const fClearPong = Effects.CLEAR_TIMEOUT({ key: "pong" });
  const fClears = [fClearCon, fClearPing, fClearPong];

  const fPingTO = Effects.SCHEDULE_TIMEOUT({
    key: "ping",
    timeoutMillis: initialContext.pingTimeoutMillis,
    onTimeout: pingtimeout,
  });
  const fPongTO = Effects.SCHEDULE_TIMEOUT({
    key: "pong",
    timeoutMillis: initialContext.pongTimeoutMillis,
    onTimeout: pongtimeout,
  });
  const fConTO = Effects.SCHEDULE_TIMEOUT({
    key: "connect",
    timeoutMillis: calcBackoff(1, 0),
    onTimeout: connect,
  });
  const fSendPing = Effects.SEND_PING();

  const fClose = Effects.TRIGGER_ACTION({ action: close });
  const fReconnect = Effects.TRIGGER_ACTION({ action: reconnect });

  test.each`
    sourceState     | action         | targetState     | expectedEffects
    ${initial}      | ${connect}     | ${connecting}   | ${[fClearCon, fCon]}
    ${initial}      | ${open}        | ${initial}      | ${[]}
    ${initial}      | ${heartbeat}   | ${initial}      | ${[]}
    ${initial}      | ${pingtimeout} | ${initial}      | ${[]}
    ${initial}      | ${pongtimeout} | ${initial}      | ${[]}
    ${initial}      | ${close}       | ${initial}      | ${[]}
    ${initial}      | ${reconnect}   | ${initial}      | ${[]}
    ${connecting}   | ${open}        | ${opened}       | ${[fPingTO]}
    ${connecting}   | ${close}       | ${closed}       | ${fClears}
    ${connecting}   | ${connect}     | ${connecting}   | ${[]}
    ${connecting}   | ${heartbeat}   | ${connecting}   | ${[]}
    ${connecting}   | ${pingtimeout} | ${connecting}   | ${[]}
    ${connecting}   | ${pongtimeout} | ${connecting}   | ${[]}
    ${connecting}   | ${reconnect}   | ${connecting}   | ${[]}
    ${opened}       | ${pingtimeout} | ${opened}       | ${[fClearPing, fSendPing, fPongTO]}
    ${opened}       | ${pongtimeout} | ${opened}       | ${[fClose, fReconnect]}
    ${opened}       | ${heartbeat}   | ${opened}       | ${[fClearPing, fClearPong, fPingTO]}
    ${opened}       | ${close}       | ${closed}       | ${fClears}
    ${opened}       | ${connect}     | ${opened}       | ${[]}
    ${opened}       | ${open}        | ${opened}       | ${[]}
    ${opened}       | ${reconnect}   | ${opened}       | ${[]}
    ${closed}       | ${reconnect}   | ${reconnecting} | ${[fConTO]}
    ${closed}       | ${connect}     | ${closed}       | ${[]}
    ${closed}       | ${open}        | ${closed}       | ${[]}
    ${closed}       | ${heartbeat}   | ${closed}       | ${[]}
    ${closed}       | ${pingtimeout} | ${closed}       | ${[]}
    ${closed}       | ${pongtimeout} | ${closed}       | ${[]}
    ${closed}       | ${close}       | ${closed}       | ${[]}
    ${reconnecting} | ${connect}     | ${connecting1}  | ${[fClearCon, fCon]}
    ${reconnecting} | ${reconnect}   | ${reconnecting} | ${[]}
    ${reconnecting} | ${open}        | ${reconnecting} | ${[]}
    ${reconnecting} | ${heartbeat}   | ${reconnecting} | ${[]}
    ${reconnecting} | ${pingtimeout} | ${reconnecting} | ${[]}
    ${reconnecting} | ${pongtimeout} | ${reconnecting} | ${[]}
    ${reconnecting} | ${close}       | ${reconnecting} | ${[]}
  `(
    "update with $sourceState gives $targetState and $expectedEffects",
    ({ sourceState, action, targetState, expectedEffects }) => {
      const [nextState, effects] = update(action, sourceState);
      expect(nextState).toStrictEqual(targetState);
      expect(effects).toStrictEqual(expectedEffects);
    },
  );
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("verify wsMachine interactions", () => {
  let server: WS | undefined;
  let machine: WSMachine | undefined;
  let messages: string[] = [];
  let stateChanges: string[] = [];

  beforeEach(async () => {
    messages = [];
    stateChanges = [];

    server = new WS("ws://localhost:1234");
    server.on("message", (ws) => {
      ws.send("pong");
    });
    machine = wsMachine({
      url: "ws://localhost:1234",
      pingTimeoutMillis: 5,
      pongTimeoutMillis: 5,
      onMessage: (msg) => {
        messages.push(msg.data);
      },
      onStateChange: ({ previous, current }) => {
        stateChanges.push(`${previous.tag}->${current.tag}`);
      },
      backoffFn: calcBackoff,
    });
  });

  afterEach(() => {
    machine?.disconnect();
    WS.clean();
  });

  test("connect to machine and verify ping", async () => {
    machine?.connect();
    await server?.connected;

    await expect(server).toReceiveMessage("ping");
    expect(server).toHaveReceivedMessages(["ping"]);
    expect(machine?.currentState()?.tag).toEqual("OPEN");
    expect(stateChanges).toEqual([
      "INITIAL->CONNECTING",
      "CONNECTING->OPEN",
      "OPEN->OPEN",
    ]);
  });

  test("connect to machine and verify message received", async () => {
    machine?.connect();
    await server?.connected;

    server?.send("test");
    expect(messages).toEqual(["test"]);
  });

  test("connect to machine and send message", async () => {
    machine?.connect();
    await server?.connected;

    machine?.send("Hello");
    await expect(server).toReceiveMessage("Hello");
  });

  test("sending message before open throws", async () => {
    machine?.connect();
    expect(() => machine?.send("Hello")).toThrow("open state");
  });

  test("server close triggers reconnect attempt(s)", async () => {
    machine?.connect();
    await server?.connected;

    server?.close();
    await server?.closed;

    expect(machine?.currentState().tag).toEqual("RECONNECTING");
  });

  test("disconnect and connect again works", async () => {
    machine?.connect();
    await server?.connected;

    machine?.disconnect();
    await server?.closed;

    machine?.connect();
    await server?.connected;

    await wait(10);

    expect(machine?.currentState().tag).toEqual("OPEN");
  });
});

test("no pong triggers reconnect", async () => {
  const server = new WS("ws://localhost:12345");
  const machine = wsMachine({
    url: "ws://localhost:12345",
    pingTimeoutMillis: 5,
    pongTimeoutMillis: 5,
    onMessage: () => {
      return;
    },
    backoffFn: calcBackoff,
  });

  machine.connect();
  await server.connected;
  await wait(15); // pong should timeout after ~10ms

  expect(machine?.currentState().tag).toEqual("RECONNECTING");
  machine.disconnect();
  expect(machine?.currentState().tag).toEqual("INITIAL");
});

test("custom ping and pong works", async () => {
  const messages: string[] = [];
  const server = new WS("ws://localhost:2345");
  const machine = wsMachine({
    url: "ws://localhost:2345",
    pingTimeoutMillis: 5,
    pongTimeoutMillis: 5,
    pingMsg: "MyPing",
    pongMsg: "MyPong",
    onMessage: (msg) => {
      messages.push(msg.data);
    },
    backoffFn: calcBackoff,
  });

  machine.connect();
  await server.connected;
  await expect(server).toReceiveMessage("MyPing");
  server.send("MyPong");
  server.send("SomeMessage");

  expect(messages).toStrictEqual(["SomeMessage"]);
  machine.disconnect();
});
