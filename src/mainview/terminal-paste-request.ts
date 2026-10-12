/**
 * "Type this text into that terminal" - asked for by a surface that holds a
 * path the user wants to hand to the agent (the file explorer), and answered by
 * the terminal itself, the only component that knows which pane has focus. A
 * target with no mounted terminal simply drops the request.
 *
 * The target is a task id, or `project-<projectId>` for the project terminal -
 * the same session key that terminal registers under.
 */

const EVENT = "dev3:requestTerminalPaste";

export function terminalPasteTarget(projectId: string, taskId?: string | null): string {
	return taskId || `project-${projectId}`;
}

export function requestTerminalPaste(target: string, text: string): void {
	window.dispatchEvent(new CustomEvent(EVENT, { detail: { target, text } }));
}

export function subscribeTerminalPaste(target: string, onRequest: (text: string) => void): () => void {
	const listener = (event: Event) => {
		const detail = (event as CustomEvent<{ target?: string; text?: string }>).detail;
		if (detail?.target === target && typeof detail.text === "string") onRequest(detail.text);
	};
	window.addEventListener(EVENT, listener);
	return () => window.removeEventListener(EVENT, listener);
}
