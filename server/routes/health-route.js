import { json } from '../http/response.js';

/** @param {import('node:http').ServerResponse} response @param {any} modelClient */
export function handleHealth(response, modelClient) {
  json(response, { ready: modelClient.configured !== false });
}
