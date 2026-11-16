import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';

/**
 * Upstream API calls. Keep these thin: build the path from validated input,
 * call the client, return the response. Every caller-supplied path segment
 * goes through encodePathParam.
 */

export async function getItem(client: UpstreamClient, input: { itemId: string }): Promise<unknown> {
  return client.get(`/items/${encodePathParam(input.itemId, 'itemId')}`);
}

export async function createItem(
  client: UpstreamClient,
  input: { name: string; description?: string },
): Promise<unknown> {
  return client.post('/items', { name: input.name, description: input.description });
}
