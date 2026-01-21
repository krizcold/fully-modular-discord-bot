// Type declarations for connect-redis v9

declare module 'connect-redis' {
  import { Store } from 'express-session';

  interface RedisStoreOptions {
    client: any; // Redis client - be flexible with the type
    prefix?: string;
    ttl?: number | ((sess: any) => number);
    disableTouch?: boolean;
    disableTTL?: boolean;
    serializer?: {
      parse: (s: string) => any;
      stringify: (obj: any) => string;
    };
  }

  class RedisStore extends Store {
    constructor(options: RedisStoreOptions);
  }

  export = RedisStore;
}
