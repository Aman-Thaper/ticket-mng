import Fastify, { type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
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
import { authRoutes } from './modules/auth/routes.js';
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

  await app.register(cookie);
  app.decorateRequest('user', null);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Ticket Management API',
        description:
          'Event ticketing: venues, seat maps, events and bookings.\n\n' +
          'Authenticate with `POST /api/v1/auth/login`, then click **Authorize** and paste the `accessToken`. ' +
          'The refresh token is set as an httpOnly cookie, so `POST /api/v1/auth/refresh` works straight from this page.',
        version: '0.2.0',
      },
      tags: [
        { name: 'auth', description: 'Signup, login, token refresh, sessions and passwords' },
        { name: 'events', description: 'Events, search and seat maps' },
        { name: 'venues', description: 'Venues and their seat layouts' },
        { name: 'users', description: 'Profiles and roles' },
        { name: 'ops', description: 'Operational endpoints' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
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
      await api.register(authRoutes);
      await api.register(userRoutes);
      await api.register(venueRoutes);
      await api.register(eventRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
