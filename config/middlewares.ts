export default [
  'strapi::logger',
  'strapi::errors',
  'strapi::security',
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
  'global::sse-nobuffer',
  {
    name: "strapi::compression",
    config: {
      // koa-compress supports a filter(contentType) but we also need ctx,
      // so we short-circuit using contentType while our sse-nobuffer sets noCompression
      // Many builds of strapi::compression pass options directly to koa-compress:
      // 'filter' can return false to skip.
      // If your build doesn't expose filter, keeping noCompression + headers still helps.
      filter: (contentType: string) => {
        // Skip compression if it's an event-stream
        if (contentType?.includes("text/event-stream")) return false;
        return true;
      },
    },
  },
];
