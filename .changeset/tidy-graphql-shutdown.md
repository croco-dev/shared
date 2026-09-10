---
"@croco/transports-graphql": patch
---

Close retained HTTP connections when GraphQLServer.stop() shuts down the listener, including requests still in progress. Concurrent stop calls share shutdown completion, and HTTP close callback errors reject the shutdown promise.
