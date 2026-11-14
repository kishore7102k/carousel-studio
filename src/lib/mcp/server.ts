import type { McpServer } from '@modelcontextprotocol/server';
import { registerBrandTools } from './tools/brand';
import { registerCarouselTools } from './tools/carousels';
import { registerRenderTools } from './tools/render';
import { registerRequestTools } from './tools/requests';
import { registerSlideTools } from './tools/slides';

/** Registry: every tool, resource and prompt the studio exposes over MCP. */
export function registerStudio(server: McpServer) {
  registerBrandTools(server);
  registerCarouselTools(server);
  registerSlideTools(server);
  registerRenderTools(server);
  registerRequestTools(server);
}
