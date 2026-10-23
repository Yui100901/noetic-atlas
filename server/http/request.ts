import type { FastifyRequest } from 'fastify';
import { parse, id } from '../core/validation.js';

export const getId = (request: FastifyRequest) => parse(id, (request.params as { id: string }).id);
