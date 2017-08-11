import * as AMQP from 'amqplib';
import * as Bluebird from 'bluebird';
import * as Uuid from 'uuid';


const EXCHANGE_NAME = 'msgr';
const DEFAULT_CONSUME_OPTIONS: Msgr.ConsumeOptions = { noAck: true };
const DEFAULT_SEND_OPTIONS: Msgr.SendOptions = { contentType: 'application/json' };

namespace Msgr {

    export interface Message<T> {
        content: T;
        fields: any;
        properties: any;
        ack: Function;
    }

    export interface SendOptions extends AMQP.Options.Publish { }

    export interface ConsumeOptions extends AMQP.Options.Consume { }

    export interface RpcOptions extends AMQP.Options.Publish {
        timeout?: number;
    }

}

class Msgr {

    private channelPromise: Bluebird<any>;
    private channel: AMQP.Channel;
    private replyQueue: string;
    private unresolved: Map<string, Function> = new Map();

    constructor(url: string) {

        this.channelPromise = this._connect(url);
    }

    rpcExec<T = any>(key: string, data: any, options: Msgr.RpcOptions = {}): Bluebird<T> {

        if (!this.channel) {
            return this._waitForChannel().then(() => this.rpcExec(key, data, options));
        }

        return new Bluebird((resolve, reject) => {

            const content = new Buffer(JSON.stringify(data));
            const correlationId = Uuid.v4();
            const timeout = options.timeout || 15000;

            const timer = setTimeout(() => {

                this.unresolved.delete(correlationId);
                reject(new Error(`RPC Server failed to respond before the configured timeout (${timeout}ms)`));
            }, timeout);

            this.unresolved.set(correlationId, (message: AMQP.Message) => {

                clearTimeout(timer);

                const response = JSON.parse(message.content.toString());
                if (response.error) {
                    return reject(new Error(response.data));
                }

                resolve(response.data);
            });

            const sendOptions = Object.assign({ }, DEFAULT_SEND_OPTIONS, {
                correlationId,
                replyTo: this.replyQueue,
                expiration: timeout
            });

            this.channel.publish(EXCHANGE_NAME, key, content, sendOptions);
        });
    }

    publish(key: string, data: any, options?: Msgr.SendOptions): void {

        if (!this.channel) {
            return void this._waitForChannel().then(() => this.publish(key, data, options));
        }

        const content = new Buffer(JSON.stringify(data));
        this.channel.publish(EXCHANGE_NAME, key, content, options);
    }

    consume<T = any>(queueName: string, callback: (msg: Msgr.Message<T>) => any, options: Msgr.ConsumeOptions = {}): void {

        if (!this.channel) {
            return void this._waitForChannel().then(() => this.consume(queueName, callback, options));
        }

        // Make sure the queue we want to consume from exists
        this.channel.assertQueue(queueName);

        const consumeOptions = Object.assign({}, DEFAULT_CONSUME_OPTIONS, options);
        this.channel.consume(queueName, (message) => callback(this._parseMessage<T>(message)), consumeOptions);
    }

    private _connect(url: string) {

        return AMQP.connect(url)
            .then((connection: AMQP.Connection) => connection.createChannel())
            .then((channel: AMQP.Channel) => {

                this.channel = channel;
                return this.channel.assertQueue('', { exclusive: true }).then((assertQueue) => {

                    this.replyQueue = assertQueue.queue;
                    return channel.bindQueue(this.replyQueue, EXCHANGE_NAME, this.replyQueue).then(() => {

                        return this.channel.consume(this.replyQueue, (message) => this._handleReply(message), DEFAULT_CONSUME_OPTIONS);
                    });
                });
            });
    }

    private _waitForChannel(): Bluebird<void> {

        return new Bluebird((resolve, reject) => {

            this.channelPromise.then(() => resolve());
        });
    }

    private _parseMessage<T>(message: AMQP.Message): Msgr.Message<T> {

        return {
            content: JSON.parse(message.content.toString()),
            properties: message.properties,
            fields: message.fields,
            ack: () => this.channel.ack(message)
        };
    }

    private _handleReply(message: AMQP.Message) {

        const correlationId = message.properties.correlationId;
        const callback = this.unresolved.get(correlationId);
        if (callback) {
            this.unresolved.delete(correlationId);
            callback(message);
        }
    }
}

export = Msgr;