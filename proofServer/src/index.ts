import "dotenv/config";
import express from "express";
import { ensureBuilt } from "./build";
import { proveRouter } from "./prove";

ensureBuilt();

const app = express();
app.use(express.json());
app.use(proveRouter);

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`🚀 snip36-server listening on http://localhost:${port}`);
});
