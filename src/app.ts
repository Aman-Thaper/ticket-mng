import Fastify, { type FastifyServerOptions } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { errorHandler } from './lib/errors.js';
import { transformObject } from './lib/openapi.js';
import { healthRoutes } from './modules/health/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { venueRoutes } from './modules/venues/routes.js';
import { eventRoutes } from './modules/events/routes.js';

export async function buildApp(opts: FastifyServerOptions = {}) {
  const app = Fastify(opts).withTypeProvider<ZodTypeProvider>();

  // Zod schemas handle request validation, response serialization and the OpenAPI spec,
  // so there's one source of truth for all three.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Ticket Management API',
        description: 'Event ticketing: venues, seat maps, events, and (soon) bookings.',
        version: '0.1.0',
      },
      tags: [
        { name: 'events', description: 'Events, search and seat maps' },
        { name: 'venues', description: 'Venues and their seat layouts' },
        { name: 'users', description: 'Users (temporary until auth)' },
        { name: 'ops', description: 'Operational endpoints' },
      ],
    },
    transform: jsonSchemaTransform,
    transformObject, // turns .meta({ id }) schemas into reusable components
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: { code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.url} not found` },
    }),
  );

  await app.register(healthRoutes);
  await app.register(
    async (api) => {
      await api.register(userRoutes);
      await api.register(venueRoutes);
      await api.register(eventRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
