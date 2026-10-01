export interface LocalBinPrompt {
  question: string;
  exposeOnPath(answer: string): boolean;
}

export function localBinPrompt(underMise: boolean): LocalBinPrompt {
  if (underMise) {
    return {
      question: "Keep DIM managed by mise without a ~/.local/bin/dim symlink? [Y/n]: ",
      exposeOnPath: (answer) => isNo(answer)
    };
  }

  return {
    question: "Expose DIM through a ~/.local/bin/dim symlink? [Y/n]: ",
    exposeOnPath: (answer) => !isNo(answer)
  };
}

function isNo(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "n" || normalized === "no";
}
