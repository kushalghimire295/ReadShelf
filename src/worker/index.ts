import { createApp, type Env } from './app'

const app = createApp()

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      return await app.fetch(request, env, ctx)
    } catch {
      return Response.json(
        { error: 'Readshelf is unavailable. Please try again later.' },
        {
          status: 503,
          headers: { 'Cache-Control': 'private, no-store' },
        },
      )
    }
  },
}
