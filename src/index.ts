import * as AMQP from 'amqplib';
import * as Bluebird from 'bluebird';
import * as Uuid from 'uuid';


const DEFAULT_CONSUME_OPTIONS: Msgr.ConsumeOptions = { noAck: true };
const DEFAULT_SEND_OPTIONS: Msgr.SendOptions = { contentType: 'application/json' };
const DEFAULT_CONNECTION_OPTIONS = {
    maxConnectionAttempts: 50,
    connectionRetryInterval: 1000
};

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

class ClientError extends Error {

    clientMessages: string[];

    constructor(message: string, clientMessages: string[]) {
        super(message);
        this.clientMessages = clientMessages;
    }
}

class Msgr {

    private options: any;
    private exchange: string;
    private channelPromise: Promise<any>;
    private channel: AMQP.Channel;
    private replyQueue: string;
    private unresolved: Map<string, Function> = new Map();

    constructor(url: string, exchange: string = 'msgr', options = {}) {

        this.options = Object.assign({}, DEFAULT_CONNECTION_OPTIONS, options);
        this.exchange = exchange;
        this.channelPromise = this._connect(url);
    }

    rpcExec<T = any>(key: string, data: any, options: Msgr.RpcOptions = {}): Promise<T> {

        if (!this.channel) {
            return this._waitForChannel().then(() => this.rpcExec(key, data, options));
        }

        return new Promise((resolve, reject) => {

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

                if (response.error && response.trace) {
                    return reject(new Error('Fatal consumer error'));
                }

                if (response.error) {
                    return reject(new ClientError('Client error', response.data));
                }

                resolve(response.data);
            });

            const sendOptions = Object.assign({ }, DEFAULT_SEND_OPTIONS, {
                correlationId,
                replyTo: this.replyQueue,
                expiration: timeout
            });

            this.channel.publish(this.exchange, key, content, sendOptions);
        });
    }

    publish(key: string, data: any, options?: Msgr.SendOptions): void {

        if (!this.channel) {
            return void this._waitForChannel().then(() => this.publish(key, data, options));
        }

        const content = new Buffer(JSON.stringify(data));
        this.channel.publish(this.exchange, key, content, options);
    }

    consume<T = any>(queueName: string, callback: (msg: Msgr.Message<T>) => any, options: Msgr.ConsumeOptions = {}): void {

        if (!this.channel) {
            return void this._waitForChannel().then(() => this.consume(queueName, callback, options));
        }

        // Make sure the queue we want to consume from exists
        this.channel.assertQueue(queueName)
            .then(() => this.channel.bindQueue(queueName, this.exchange, queueName))
            .then(() => {

                const consumeOptions = Object.assign({}, DEFAULT_CONSUME_OPTIONS, options);
                this.channel.consume(queueName, (message) => callback(this._parseMessage<T>(message)), consumeOptions);
            });
    }

    private async _connect(url: string, attempts = 1) {

        if (attempts > 1) {
            console.log(`AMQP connection attempt ${attempts} of ${this.options.maxConnectionAttempts}.`);
        }

        const connection = await AMQP.connect(url);
        this.channel = await connection.createChannel();

        if (attempts < this.options.maxConnectionAttempts) {
            this.channel.once('error', (e) => {

                console.log(`AMQP connection failed. Retrying in ${this.options.connectionRetryInterval}ms.`);
                connection.close();
                this.channel = null;
                this.channelPromise = new Promise((resolve) => setTimeout(resolve, this.options.connectionRetryInterval))
                    .then(() => this._connect(url, ++attempts));
            });
        }

        const assertQueue = await this.channel.assertQueue('', { exclusive: true })
        this.replyQueue = assertQueue.queue;

        await this.channel.bindQueue(this.replyQueue, this.exchange, this.replyQueue);

        this.channel.consume(this.replyQueue, (message) => this._handleReply(message), DEFAULT_CONSUME_OPTIONS);
    }

    private _waitForChannel() {

        return new Promise((resolve, reject) => {

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