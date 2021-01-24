# ts-ws-machine
TypeScript WebSocket Client modelled as an FSM. Comes with reconnect and heartbeat support


##Installation

```bash
npm install ts-ws-machine
```

```bash
yarn add ts-ws-machine
```




## Usage
```typescript
import { wsMachine, calcBackoff } from "ts-ws-machine";

const ws = wsMachine({
  url: "ws://localhost:3000/ws",
  pingTimeoutMillis: 10000,
  pongTimeoutMillis: 10000,
  backoffFn: calcBackoff,
  onMessage: (msg) => {
    console.log("Some websocket message", msg.data);
  }, 
  // Optional
  pingMsg: "MyPingMessage",
  // Optional
  pongMsg: "MyPongMessage",
  // Optional
  onStateChange: ({ previous, current }) => {
    console.log(`State changed: ${previous.tag} -> ${current.tag}`);
  },  
});

ws.connect();
ws.send("Msg to server");
// do other stuff
ws.disconnect();
```

###Heartbeats
WSMachine will regularly send a ping message `pingTimeoutMillis` after it last received a response from the ws endpoint.
After a ping message is sent it will wait up-to `pongTimeoutMillis`, if no response is received from the server within that time period, the underlying websocket will be closed
and WSMachine will attempt to reconnect. If indeed a message is received (either a "pong" message or any other message really), a new ping will be scheduled.

###Reconnect
WSMachine will automatically try to reconnect if the underlying websocket is closed or a heartbeat is missed.
This lib comes with a default backoff implementation (`calcBackoff`) using an exponential backoff with some "jitter".
  
```typescript
// attempt is current number of reconnects attempted
// randSeed is a random number between 0 and 1, initialized when you call then `wsMachine` function.
export type BackoffFn = (attempt: number, randSeed: number) => number

// constant backoff
const constantBackoff = (attempt: number, randSeed: number) => 1000;

// linear backoff
const linearBackoff = (attempt: number, randSeed: number) => 1000 * attempt;

// sort of random backoff :)
const randomBackoff = (attempt: number, randSeed: number) => 1000 * attempt * randSeed;

```


###Config
- **url**: A valid websocket url
- **pingTimeoutmillis**: Number of milliseconds to wait since last hearing from the server before sending a ping message
- **pongTimeoutmillis**: Number of milliseconds to wait for server to send a message response after a ping message has been sent
- **pingMessage**: (optional) Custom ping message. Default is `ping`
- **pongMessage**: (optional) Custom pong message. Default is `pong`
- **onMessage**: Callback for messages from the server. Messages matching `pongMessage` are filtered out.
- **onStateChange**: (optional) Callback for listening to state changes from the statemachine. Handy for debugging, or for displaying the health of your websocket connection. 
