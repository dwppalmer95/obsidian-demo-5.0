import { graphql } from 'https://cdn.pika.dev/graphql@15.0.0';
import { renderPlaygroundPage } from 'https://deno.land/x/oak_graphql@0.6.2/graphql-playground-html/render-playground-html.ts';
import { makeExecutableSchema } from 'https://deno.land/x/oak_graphql@0.6.2/graphql-tools/schema/makeExecutableSchema.ts';
import { Cache } from './quickCache.js';
// FLAG: Cache should be passed into ObsidianRouter as an object
  // you have an issue where you need a specific .env configuration, like
  // the one shown in quickCache.js
import queryDepthLimiter from './DoSSecurity.ts';
import { restructure } from './restructure.ts';
import { rebuildFromQuery } from './rebuild.js'
import { normalizeObject } from './normalize.ts'
import { transformResponse, detransformResponse } from './transformResponse.ts'
import { isMutation, invalidateCache } from './invalidateCacheCheck.ts'

interface Constructable<T> {
  new(...args: any): T & OakRouter;
}

interface OakRouter {
  post: any;
  get: any;
  obsidianSchema?: any;
}

export interface ObsidianRouterOptions<T> {
  Router: Constructable<T>;
  path?: string;
  typeDefs: any;
  resolvers: ResolversProps;
  context?: (ctx: any) => any;
  usePlayground?: boolean;
  useCache?: boolean; // trivial parameter
  redisPort?: number;
  policy?: string;
  maxmemory?: string;
  maxQueryDepth?: number;
  useQueryCache?: boolean; // trivial parameter
  useRebuildCache?: boolean;
  customIdentifier?: Array<string>;
}

export interface ResolversProps {
  Query?: any;
  Mutation?: any;
  [dynamicProperty: string]: any;
}

// Export developer chosen port for redis database connection //
export let redisPortExport: number = 6379;

/**
 * 
 * @param param0 
 * @returns 
 */
export async function ObsidianRouter<T>({
  Router,
  path = '/graphql',
  typeDefs,
  resolvers,
  context,
  usePlayground = false,
  useCache = true,
  redisPort = 6379,
  policy = 'allkeys-lru',
  maxmemory = '2000mb',
  maxQueryDepth = 0,
  // useQueryCache: option to store entire query
  useQueryCache = true,
  useRebuildCache = true,
  customIdentifier = ["id", "__typename"],
}: ObsidianRouterOptions<T>): Promise<T> {
  redisPortExport = redisPort;
  const router = new Router();
  // create the schema by combining typeDefs and resovlers
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  // const cache = new LFUCache(50); // If using LFU Browser Caching, uncomment line
  // get the caching object 
  // FLAG: the construction of the cache object should be conditional 
    // if there is no redis set up, you would get an exception here
  const cache = new Cache(); // If using Redis caching, uncomment line
  cache.cacheClear();
  if (policy || maxmemory) { // set redis configurations
    cache.configSet('maxmemory-policy', policy);
    cache.configSet('maxmemory', maxmemory);
  }
  // set up oak router middleware to handle post requests to /graphql
  await router.post(path, async (ctx: any) => {
    // set the time since the window context was created (time since app started running)
    const t0 = performance.now();
    // desctructure context
    const { response, request } = ctx;
    if (!request.hasBody) return;
    try {
      // context is an optional function passed into the router to act on the Oak context object
      // run context function
      const contextResult = context ? await context(ctx) : undefined;
      // get the body object of the request
      let body = await request.body().value;
      // check the query depth for dos security
      if (maxQueryDepth) queryDepthLimiter(body.query, maxQueryDepth); // If a securty limit is set for maxQueryDepth, invoke queryDepthLimiter, which throws error if query depth exceeds maximum
      body = { query: restructure(body) }; // Restructre gets rid of variables and fragments from the query
      // get the query's value (i.e. the response which would be generated if the query were sent) from the cach, if it exists
      let cacheQueryValue = await cache.read(body.query)
      // if the data was found in the cache and the option to store the entire query is set
      if (useCache && useQueryCache && cacheQueryValue) {
        // retrieve original query response by unhashing the cache value
        let detransformedCacheQueryValue = await detransformResponse(body.query, cacheQueryValue)
        if (!detransformedCacheQueryValue) {
          // cache was evicted if any partial cache is missing, which causes detransformResponse to return undefined
          cacheQueryValue = undefined;
        } else {
          // attach appropriate response body
          response.status = 200;
          response.body = detransformedCacheQueryValue;
          const t1 = performance.now();
          // log performance - opportunity here to store performance for analysis
          console.log(
            '%c Obsidian retrieved data from cache and took ' +
            (t1 - t0) +
            ' milliseconds.', "background: #222; color: #00FF00"
          );
        }

      };      // If not in cache: 
      if (useCache && useQueryCache && !cacheQueryValue) {
        // make the graphQL query request and store the response
        const gqlResponse = await (graphql as any)(
          schema,
          body.query,
          resolvers,
          contextResult,
          body.variables || undefined,
          body.operationName || undefined
        );
        // normalize the response
        const normalizedGQLResponse = normalizeObject(gqlResponse, customIdentifier);
        
        if (isMutation(body)) {
          const queryString = await request.body().value;
          invalidateCache(normalizedGQLResponse, queryString.query);
        }
        // If read query: run query, normalize GQL response, transform GQL response, write to cache, and write pieces of normalized GQL response objects
        else {
          // FLAG: see comments in transformResponse
          const transformedGQLResponse = transformResponse(gqlResponse, customIdentifier);
          await cache.write(body.query, transformedGQLResponse, false);
          for (const key in normalizedGQLResponse) {
            await cache.cacheWriteObject(key, normalizedGQLResponse[key]);
          }
        }
        response.status = 200;
        response.body = gqlResponse;
        const t1 = performance.now();
        console.log(
          '%c Obsidian received new data and took ' +
          (t1 - t0) +
          ' milliseconds', 'background: #222; color: #FFFF00'
        );
      }
    } catch (error) {
      response.status = 400;
      response.body = {
        data: null,
        errors: [
          {
            message: error.message ? error.message : error,
          },
        ],
      };
      console.error('Error: ', error.message);
    }
  });

  // serve graphql playground
  await router.get(path, async (ctx: any) => {
    const { request, response } = ctx;
    if (usePlayground) {
      const prefersHTML = request.accepts('text/html');
      const optionsObj: any = {
        'schema.polling.enable': false, // enables automatic schema polling
      }

      if (prefersHTML) {

        const playground = renderPlaygroundPage({
          endpoint: request.url.origin + path,
          subscriptionEndpoint: request.url.origin,
          settings: optionsObj
        });
        response.status = 200;
        response.body = playground;
        return;
      }
    }
  });

  return router;
}
