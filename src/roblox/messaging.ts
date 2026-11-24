import { OPEN_CLOUD, type RobloxHttp } from './http.js';

/** MessagingService messages are limited to 1 kB. */
export const MESSAGE_LIMIT_BYTES = 1024;

/**
 * Publishes to MessagingService through Open Cloud (Messaging Service API v1).
 * Every live server subscribed to the topic receives the message within a few seconds.
 *
 * Key scope needed: universe-messaging-service:publish on the experience.
 */
export class MessagingPublisher {
  constructor(
    private readonly http: RobloxHttp,
    private readonly universeId: number,
  ) {}

  async publish(topic: string, message: string): Promise<void> {
    if (!/^[\w-]{1,80}$/.test(topic)) throw new Error(`Bad topic name "${topic}"`);
    const size = Buffer.byteLength(message, 'utf8');
    if (size > MESSAGE_LIMIT_BYTES) throw new Error(`Message is ${size} bytes; MessagingService allows ${MESSAGE_LIMIT_BYTES}.`);
    await this.http.post(`${OPEN_CLOUD}/messaging-service/v1/universes/${this.universeId}/topics/${encodeURIComponent(topic)}`, {
      auth: true,
      body: { message },
    });
  }
}
