declare module "neo-blessed" {
  export namespace Widgets {
    interface Screen {
      key(keys: string[], handler: () => void): void;
      render(): void;
      destroy(): void;
    }

    interface BlessedElement {
      focus(): void;
      show(): void;
      hide(): void;
      destroy(): void;
      setContent(content: string): void;
      key(keys: string[], handler: () => void): void;
      on(event: string, handler: (...args: any[]) => void): void;
      readInput(callback: (...args: any[]) => void): void;
      clearValue(): void;
      getValue(): string;
      setValue(value: string): void;
      setItems(items: string[]): void;
      select(index: number): void;
      selected: number;
      ask(question: string, callback: (err: any, ok: boolean) => void): void;
    }
  }

  export function screen(opts: any): Widgets.Screen;
  export function box(opts: any): Widgets.BlessedElement;
  export function list(opts: any): Widgets.BlessedElement;
  export function textbox(opts: any): Widgets.BlessedElement;
  export function textarea(opts: any): Widgets.BlessedElement;
  export function question(opts: any): Widgets.BlessedElement;

  const blessed: {
    screen: typeof screen;
    box: typeof box;
    list: typeof list;
    textbox: typeof textbox;
    textarea: typeof textarea;
    question: typeof question;
    Widgets: typeof Widgets;
  };
  export default blessed;
}
