import { resolveLayout } from "../../src/layout";
import { tryAcquireSlot } from "../../src/slots";

// Takes the machine slot, reports it on stdout, then stays alive until it is killed.
tryAcquireSlot(resolveLayout(), 1).then((lock) => {
  console.log(lock ? "held" : "busy");
  setInterval(() => {}, 1000);
});
