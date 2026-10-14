/**
 * The second step of a new project: gitring's guesses for the chosen source, each editable in place.
 *
 * There is ONE button: "Create project" (Enter). The sources: a description (a template, the first task and
 * built-in agents), a template, an upload, a push, any git URL, a GitHub repository.
 * This file is the front door of steps/: NewProject.tsx imports every step from here.
 */
export { DescribeStep } from "./steps/DescribeStep";
export { GithubStep } from "./steps/GithubStep";
export { PlainStep } from "./steps/PlainStep";
export { TemplateStep } from "./steps/TemplateStep";
export { UploadStep } from "./steps/UploadStep";
export { UrlStep } from "./steps/UrlStep";
export type { StepProps } from "./steps/shared";

