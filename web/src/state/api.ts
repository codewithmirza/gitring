/**
 * The project client: the Worker's REST API under /api/projects/:p and the live events over /ws/:p.
 * This file is the front door. The code lives in api/: types, the request client, the live socket and the boot.
 * Boot: the UI asks for the person, the project list and the state of one project (api/boot.ts). After that the
 * WebSocket brings every change and nothing polls. There is no offline or fake data path.
 * Requests go through ./http: identical GETs share one fetch, views can abort, and answers that never change stay in LRU caches.
 * Read api/README.md for the list of files.
 */
import type { ApprovalResult, ConnectInfo, TreeResponse } from "../../../src/core/types";
import { HttpError, isAbort } from "./http";
export { harbor, harborOrNull, onHarbor, defaultProjectFor, ME_TTL, PROJECTS_TTL, boot, syncProject } from "./api/boot";
export { isCommitId, LiveHarbor, defaultConnectInfo } from "./api/harbor-client";
export type { DiffFile, DiffResult, LandingDetail, NewIntentInput, AmendInput, LandResult, DecideInput, ReadOptions, VersionedRead, HarborClient } from "./api/types";

export type { ApprovalResult, ConnectInfo, TreeResponse };
export { HttpError as ApiError, isAbort };
