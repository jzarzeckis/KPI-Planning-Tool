import { handleSignaling } from "../src/handleSignaling";

export default {
  async fetch(request: Request) {
    return handleSignaling(request);
  },
};
