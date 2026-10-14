/**
 * Puts the hooks of the code view together into one model that the panes of the screen read.
 * Each hook owns one concern. A hook gets the results of the hooks before it, never of the hooks after it.
 */
import { describeRef } from "./describeRef";
import { renderMain } from "./renderMain";
import { useCodeActions } from "./useCodeActions";
import { useCodeCursor } from "./useCodeCursor";
import { useCodeNavigation } from "./useCodeNavigation";
import { useCodePanels } from "./useCodePanels";
import { useCodeSource } from "./useCodeSource";
import { useFileTree } from "./useFileTree";
import { useOpenFile } from "./useOpenFile";

export function useCodeView() {
  const source = useCodeSource();
  const treeRows = useFileTree(source);
  const openFile = useOpenFile(source, treeRows);
  const cursor = useCodeCursor(source, openFile);
  const panels = useCodePanels(source);
  const navigation = useCodeNavigation(source, treeRows, openFile, panels);
  const actions = useCodeActions(source, openFile, cursor, panels);
  const labels = describeRef(source);
  const main = renderMain(source, treeRows, openFile, cursor, panels, labels);
  return { ...source, ...treeRows, ...openFile, ...cursor, ...panels, ...navigation, ...actions, ...labels, main };
}

export type CodeViewModel = ReturnType<typeof useCodeView>;
