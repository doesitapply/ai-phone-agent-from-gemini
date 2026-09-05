interface Window {
  google?: {
    accounts?: {
      id?: {
        initialize: (input: Record<string, unknown>) => void;
        renderButton: (element: HTMLElement, input: Record<string, unknown>) => void;
      };
    };
  };
}
