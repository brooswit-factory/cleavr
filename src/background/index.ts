import { createRealOpener } from "../lib/pty/opener";
import { wirePtyConnections, fetchResources } from "./wire";

wirePtyConnections(createRealOpener());

export { fetchResources };
