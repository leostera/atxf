import type { APIRoute } from "astro";
import { schemaText } from "../../../lib/site";

export const GET: APIRoute = () =>
  new Response(schemaText("0.1"), { headers: { "content-type": "application/schema+json; charset=utf-8" } });
