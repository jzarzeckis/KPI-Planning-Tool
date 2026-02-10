/**
 * Re-export signaling store from shared source.
 * Underscore prefix ensures Vercel doesn't treat this as a route.
 */
export {
  joinSession,
  createSession,
  deleteSession,
  submitAnswer,
  pollAnswer,
  replaceOffer,
} from "../src/signaling";
