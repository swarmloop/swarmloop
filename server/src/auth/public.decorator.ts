import { SetMetadata } from '@nestjs/common';

export const PUBLIC_KEY = 'swarmloop:public';

/** Marks a controller as open to anyone. Only the health check and the login routes carry it. */
export const Public = (): ClassDecorator => SetMetadata(PUBLIC_KEY, true);
