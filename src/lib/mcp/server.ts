import type { McpServer } from '@modelcontextprotocol/server';
import { registerAccessTools } from './tools/access';
import { registerBrandTools } from './tools/brand';
import { registerCarouselTools } from './tools/carousels';
import { registerCompatTools } from './tools/compat';
import { registerRenderTools } from './tools/render';
import { registerRequestTools } from './tools/requests';
import { registerSlideTools } from './tools/slides';

/** Registry: every tool, resource and prompt the studio exposes over MCP. compat.ts also registers the resource and prompts. */
export function registerStudio(server: McpServer) {
  registerBrandTools(server);
  registerCarouselTools(server);
  registerSlideTools(server);
  registerRenderTools(server);
  registerRequestTools(server);
  registerAccessTools(server);
  registerCompatTools(server);
}
