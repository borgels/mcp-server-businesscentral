import { nestedFailuresAsStatus } from '../errors.js';
import type { UpstreamClient } from './client.js';

/**
 * Business Central API v2.0 reads. The base URL is the environment's API root,
 * `https://api.businesscentral.dynamics.com/v2.0/{tenant}/{environment}/api/v2.0`;
 * every entity below a company is addressed as `/companies({companyId})/<entity>`.
 * Ids are GUIDs, checked by the tool schemas and again here before they go
 * into a path, so no caller text reaches the path unchecked.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function guid(value: string, name: string): string {
  if (!GUID.test(value)) {
    throw new Error(`${name} must be a GUID.`);
  }
  return value.toLowerCase();
}

/** The company-scoped entities the list tools read. Fixed: a tool never reads an entity chosen by its input. */
export type Entity =
  | 'customers'
  | 'vendors'
  | 'items'
  | 'salesInvoices'
  | 'purchaseInvoices'
  | 'accounts'
  | 'generalLedgerEntries';

export interface ListInput {
  companyId: string;
  top?: number;
  skip?: number;
  filter?: string;
}

/** The page size when `top` is not given. */
export const DEFAULT_TOP = 50;

export async function listCompanies(client: UpstreamClient): Promise<unknown> {
  return nestedFailuresAsStatus(await client.get('/companies'));
}

export async function listEntity(client: UpstreamClient, entity: Entity, input: ListInput): Promise<unknown> {
  const path = `/companies(${guid(input.companyId, 'companyId')})/${entity}`;
  return nestedFailuresAsStatus(
    await client.get(path, {
      $top: input.top ?? DEFAULT_TOP,
      $skip: input.skip,
      $filter: input.filter,
    }),
  );
}

export async function getEntity(
  client: UpstreamClient,
  entity: 'customers' | 'salesInvoices',
  companyId: string,
  id: string,
  expand?: string,
): Promise<unknown> {
  const path = `/companies(${guid(companyId, 'companyId')})/${entity}(${guid(id, 'id')})`;
  return nestedFailuresAsStatus(await client.get(path, expand ? { $expand: expand } : undefined));
}
