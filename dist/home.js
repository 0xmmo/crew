"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.crewHome = crewHome;
exports.legacyCrewHome = legacyCrewHome;
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
/** Product-neutral state shared by Claude and Codex sessions. */
function crewHome() {
    return (0, node_path_1.resolve)(process.env.CREW_HOME || (0, node_path_1.join)((0, node_os_1.homedir)(), ".crew"));
}
/** Inbox location used by crew <= 0.2.x; kept readable during migration. */
function legacyCrewHome() {
    const claudeHome = process.env.CLAUDE_HOME || (0, node_path_1.join)((0, node_os_1.homedir)(), ".claude");
    return (0, node_path_1.resolve)((0, node_path_1.join)(claudeHome, "crew"));
}
