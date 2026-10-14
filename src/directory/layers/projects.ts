/**
 * The project registry: which projects exist, who may do what in each, and the members.
 *
 * The project coordinator (HarborMaster) holds the state of a project. This layer only knows that a project exists.
 * Roles are owner, member and viewer. An invite by email or login becomes a role at the next sign-in.
 */
import type * as A from "../../core/accounts";
import { PROJECT_ID } from "../../core/accounts";
import type { ProjectSource } from "../../core/types";
import { rand } from "../../harbor/ids";
import { MAX_PROJECTS_PER_USER } from "../constants";
import type { ProjectRow } from "../types";
import { normalizeRemote } from "../helpers";
import { DirectoryCredentials } from "./credentials";

export abstract class DirectoryProjects extends DirectoryCredentials {
  // ───── Visibility and the GitHub link ─────

  /** "public" or "private" (null: unknown or archived project). */
  async visibilityOf(projectId: string): Promise<A.Visibility | null> {
    return this.projectRow(projectId)?.visibility ?? null;
  }

  /** A project links a GitHub repository (or none). Worker-only, RPC from the project coordinator. */
  async githubLink(projectId: string, repo: string | null): Promise<void> {
    this.sql.exec("DELETE FROM github_links WHERE project_id = ?", projectId);
    if (repo) this.sql.exec("INSERT OR REPLACE INTO github_links (repo, project_id) VALUES (?, ?)", repo.toLowerCase(), projectId);
  }

  /** Projects (not archived) that link this GitHub repository. */
  async githubLinkedProjects(repo: string): Promise<string[]> {
    return this.sql
      .exec<{ project_id: string }>("SELECT l.project_id FROM github_links l JOIN projects p ON p.id = l.project_id WHERE l.repo = ? AND p.archived = 0", String(repo ?? "").toLowerCase())
      .toArray()
      .map((r) => r.project_id);
  }

  // ───── Reading projects and roles ─────

  protected projectRow(id: string): ProjectRow | undefined {
    return this.sql.exec<ProjectRow>("SELECT * FROM projects WHERE id = ? AND archived = 0", id).toArray()[0];
  }

  protected roleIn(row: ProjectRow, userId: string | null): A.Role | null {
    if (userId) {
      if (this.isAdmin(userId)) return "owner";
      const m = this.sql.exec<{ role: A.Role }>("SELECT role FROM members WHERE project_id = ? AND user_id = ?", row.id, userId).toArray()[0];
      if (m) return m.role;
    }
    return row.visibility === "public" ? "viewer" : null;
  }

  private info(row: ProjectRow, userId: string | null): A.ProjectInfo {
    const owner = row.owner_id ? this.sql.exec<{ name: string }>("SELECT name FROM users WHERE id = ?", row.owner_id).toArray()[0]?.name : "gitring";
    return {
      id: row.id,
      name: row.name,
      visibility: row.visibility,
      source: JSON.parse(row.source) as ProjectSource,
      createdAt: row.created_at,
      ownerName: owner,
      role: this.roleIn(row, userId),
    };
  }

  async project(id: string, userId: string | null): Promise<A.ProjectInfo | null> {
    const row = this.projectRow(id);
    if (!row) return null;
    const info = this.info(row, userId);
    return info.role ? info : null;
  }

  /** The caller's role on a project (null: the project is unknown or hidden from the caller). */
  async role(id: string, userId: string | null): Promise<A.Role | null> {
    const row = this.projectRow(id);
    return row ? this.roleIn(row, userId) : null;
  }

  async exists(id: string): Promise<boolean> {
    return Boolean(this.projectRow(id));
  }

  /**
   * Projects imported from (or linked to) a GitHub repository in which the sender of an issue may open
   * tasks: a member or owner, matched by GitHub account id (a login can be renamed and taken by
   * someone else), or a pending invite of the login (nobody accepted it yet, so the login is all there is).
   * An issue event from an installed repository only reaches these.
   */
  async projectsForGithubLogin(url: string, login: string, senderId?: number): Promise<string[]> {
    const want = normalizeRemote(url);
    const l = String(login ?? "").toLowerCase();
    if (!l) return [];
    const userId = senderId !== undefined ? (this.sql.exec<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?", String(senderId)).toArray()[0]?.user_id ?? null) : null;
    const out: string[] = [];
    const repo = /github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i.exec(url)?.[1]?.toLowerCase() ?? "";
    const linked = new Set(repo ? this.sql.exec<{ project_id: string }>("SELECT project_id FROM github_links WHERE repo = ?", repo).toArray().map((r) => r.project_id) : []);
    for (const row of this.sql.exec<ProjectRow>("SELECT * FROM projects WHERE archived = 0").toArray()) {
      const s = JSON.parse(row.source) as ProjectSource;
      const match = (s.kind === "git" && normalizeRemote(s.url) === want) || (s.kind === "github" && s.repo.toLowerCase() === repo) || linked.has(row.id);
      if (!match) continue;
      const role = userId ? this.roleIn(row, userId) : null;
      const invited = this.sql.exec<{ role: A.Role }>("SELECT role FROM members WHERE project_id = ? AND handle = ? AND user_id IS NULL", row.id, `github:${l}`).toArray()[0]?.role ?? null;
      if ((role === "owner" || role === "member") || invited === "owner" || invited === "member") out.push(row.id);
    }
    return out;
  }

  /** Projects that a person can see. `all`: every project (the operator key acts as the deployment). */
  async listProjects(userId: string | null, all = false): Promise<A.ProjectInfo[]> {
    const rows = this.sql.exec<ProjectRow>("SELECT * FROM projects WHERE archived = 0 ORDER BY created_at DESC").toArray();
    if (all) return rows.map((r) => ({ ...this.info(r, null), role: "owner" as const }));
    return rows.map((r) => this.info(r, userId)).filter((p) => p.role !== null);
  }

  // ───── Making and changing projects ─────

  /**
   * Make a project. ownerId null: the operator key made it, and no person owns it (deployment owners act
   * on it). `id`: a free id that a guess offered (it must start with the name's slug); otherwise a new one.
   */
  async createProject(input: { name: string; visibility?: A.Visibility; source: ProjectSource; ownerId: string | null; id?: string }): Promise<A.ProjectInfo> {
    const owner = input.ownerId === null ? null : this.userInfo(input.ownerId);
    if (input.ownerId !== null && !owner) throw new Error("Sign in first.");
    const name = String(input.name ?? "").trim().slice(0, 80);
    if (!name) throw new Error("Give the project a name.");
    if (owner && !owner.admin) {
      const n = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM projects WHERE owner_id = ? AND archived = 0", owner.id).one().n;
      if (n >= MAX_PROJECTS_PER_USER) throw new Error(`You have ${MAX_PROJECTS_PER_USER} projects. Archive one first.`);
    }
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "project";
    const taken = (x: string) => Boolean(this.sql.exec("SELECT id FROM projects WHERE id = ?", x).toArray()[0]);
    const asked = input.id && PROJECT_ID.test(input.id) && input.id.startsWith(`${base}-`) ? input.id : undefined;
    let id = asked && !taken(asked) ? asked : `${base}-${rand(4)}`;
    while (taken(id)) id = `${base}-${rand(4)}`;
    if (!PROJECT_ID.test(id)) throw new Error("gitring could not make an id for this name. Use letters and digits.");
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO projects (id, name, owner_id, visibility, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      name,
      owner?.id ?? null,
      input.visibility === "public" ? "public" : "private",
      JSON.stringify(input.source),
      now,
    );
    if (!owner) return { ...this.info(this.projectRow(id)!, null), role: "owner" };
    this.sql.exec("INSERT INTO members (project_id, handle, user_id, role) VALUES (?, ?, ?, 'owner')", id, `user:${owner.id}`, owner.id);
    return this.info(this.projectRow(id)!, owner.id);
  }

  /** Undo a creation whose repository could not be made. */
  async dropProject(id: string): Promise<void> {
    this.sql.exec("DELETE FROM members WHERE project_id = ?", id);
    this.sql.exec("DELETE FROM projects WHERE id = ?", id);
  }

  async archiveProject(id: string): Promise<void> {
    this.sql.exec("UPDATE projects SET archived = 1 WHERE id = ?", id);
  }

  async updateProject(id: string, patch: { name?: string; visibility?: A.Visibility }): Promise<A.ProjectInfo> {
    const row = this.projectRow(id);
    if (!row) throw new Error("Unknown project.");
    if (patch.name?.trim()) this.sql.exec("UPDATE projects SET name = ? WHERE id = ?", patch.name.trim().slice(0, 80), id);
    if (patch.visibility === "public" || patch.visibility === "private") this.sql.exec("UPDATE projects SET visibility = ? WHERE id = ?", patch.visibility, id);
    return this.info(this.projectRow(id)!, null);
  }

  // ───── Members ─────

  async members(id: string): Promise<A.MemberInfo[]> {
    const rows = this.sql
      .exec<{ handle: string; user_id: string | null; role: A.Role; name: string | null }>(
        "SELECT m.handle, m.user_id, m.role, u.name FROM members m LEFT JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.role DESC, u.name",
        id,
      )
      .toArray();
    return rows.map((r) => ({
      userId: r.user_id ?? undefined,
      name: r.name ?? r.handle.replace(/^(github|email|user):/, ""),
      handle: r.handle.replace(/^(github|email|user):/, ""),
      role: r.role,
      pending: !r.user_id,
    }));
  }

  /**
   * Add a person by account id ("u_…", also "user:u_…": a person who exists, for example with passkeys
   * only), or invite by email or GitHub login (no @). An invite becomes a role at the next sign-in.
   */
  async addMember(id: string, who: string, role: A.Role): Promise<A.MemberInfo[]> {
    if (!this.projectRow(id)) throw new Error("Unknown project.");
    if (!["owner", "member", "viewer"].includes(role)) throw new Error("Use the role owner, member or viewer.");
    const raw = String(who ?? "").trim().replace(/^@/, "").toLowerCase();
    if (!raw) throw new Error("Give an account id, an email or a GitHub login.");
    const account = /^(?:user:)?(u_[a-z0-9]{10})$/.exec(raw)?.[1];
    if (account) {
      if (!this.userInfo(account)) throw new Error("gitring has no account with this id.");
      this.sql.exec("DELETE FROM members WHERE project_id = ? AND user_id = ?", id, account);
      this.sql.exec("INSERT OR REPLACE INTO members (project_id, handle, user_id, role) VALUES (?, ?, ?, ?)", id, `user:${account}`, account, role);
      return this.members(id);
    }
    const handle = raw.includes("@") ? `email:${raw}` : `github:${raw}`;
    if (!/^(email:[^\s@]+@[^\s@]+\.[^\s@]+|github:[a-z0-9-]{1,39})$/.test(handle)) throw new Error("This is not an account id, an email or a GitHub login.");
    const known = raw.includes("@")
      ? this.sql.exec<{ user_id: string }>("SELECT user_id FROM identities WHERE lower(email) = ? LIMIT 1", raw).toArray()[0]
      : this.sql.exec<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = 'github' AND lower(login) = ? LIMIT 1", raw).toArray()[0];
    if (known) this.sql.exec("DELETE FROM members WHERE project_id = ? AND user_id = ?", id, known.user_id);
    this.sql.exec("INSERT OR REPLACE INTO members (project_id, handle, user_id, role) VALUES (?, ?, ?, ?)", id, handle, known?.user_id ?? null, role);
    return this.members(id);
  }

  async removeMember(id: string, handleOrUser: string): Promise<A.MemberInfo[]> {
    const owners = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM members WHERE project_id = ? AND role = 'owner' AND user_id IS NOT NULL", id).one().n;
    const target = this.sql
      .exec<{ handle: string; role: A.Role; user_id: string | null }>(
        "SELECT handle, role, user_id FROM members WHERE project_id = ? AND (user_id = ? OR handle LIKE ?)",
        id,
        handleOrUser,
        `%:${String(handleOrUser).toLowerCase()}`,
      )
      .toArray()[0];
    if (!target) throw new Error("This person is not a member.");
    if (target.role === "owner" && target.user_id && owners <= 1) throw new Error("A project needs at least one owner.");
    this.sql.exec("DELETE FROM members WHERE project_id = ? AND handle = ?", id, target.handle);
    return this.members(id);
  }
}
