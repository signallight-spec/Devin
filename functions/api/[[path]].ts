import { handleApi } from "../lib/handlers";
import { errorResponse } from "../lib/http";
import type { Env } from "../lib/types";

export const onRequest: PagesFunction<Env> = async (context) => {
  try {
    return await handleApi(context.request, context.env);
  } catch (error) {
    return errorResponse(error);
  }
};
