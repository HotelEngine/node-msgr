# node-msgr

`node-msgr` is a node amqp client built on top of libamqp and meant to be a companion to the ruby [msgr](https://github.com/jgraichen/msgr) gem.  It supports standard publishing and consuming as well as the RPC pattern.  By convention all queues are bound to the `msgr` exchange and the client deals exclusively with routing keys on this exchange instead of individual queue names.

### Connecting to a rabbit server
To begin using the client create a new instance with the url for the server you want to connect to as an argument to the constructor.
```
const msgr = new Msgr('amqp://myserverurl');
```
This will immediately return a usable client instance.

### Publishing a message
Publishing a message to the exchange is done with the `publish()` method.  The first argument is the routing key and the second is the data you want to send and can be anything serializable by `JSON.stringify()`. There is an optional third parameter to set options when publishing that is passed through to libamqp.  Available options are documented [here](http://www.squaremobius.net/amqp.node/channel_api.html#channel_publish).
```
const data = {
    some: "thing",
    to: "send"
};
msgr.publish('my_topic', data);
```

### Consuming messages
Consuming messages requires a routing key and a callback. Consuming can also take an optional third param to configure the consumer/queue.  Those options are documented [here](http://www.squaremobius.net/amqp.node/channel_api.html#channel_consume).
```
msgr.consume('my_topic', (message) => {
    // do a thing with the message
});
```
A message will be an object with:
* A `content` property containing the deserialized body of the message
* `properties` and `fields` properties containing some additional informationa about the message mostly used internally by libamqp. See the [libamqp docs](http://www.squaremobius.net/amqp.node/channel_api.html#channel_consume) for more info.
* An `ack` method for use if the queue requires messages to be acknowledged. This method is available on _every_ message, even if the originating queue was created with `noAck: true`.  Calling this method on a message that cannot be acknowledged will cause an error.

### RPC
The `rpcExec()` method takes the same set of parameters as `publish()` including options.  It returns a promise that will be resolved with the content of the reply message (not the message itself) or be rejected with either a timeout error or an error provided by the rpc server.  The default timeout is 15 seconds and can be adjusted by setting the `timeout` option with the desired value in milliseconds.  The response from the rpc server is expected to be an object with two properties, `data` and `error`.  If the value of `error` is true then the promise will be rejected with the value of `data`, otherwise the promise will be resolved with the value of `data`.
```
const data = {
    some: "thing",
    to: "send"
};
msgr.rpcExec('my_topic', data).then((response) => {
    // do a thing with the response
});
```

### Caveats
* Only JSON payloads are supported
* There is no method for creating an RPC server/listener (yet)
