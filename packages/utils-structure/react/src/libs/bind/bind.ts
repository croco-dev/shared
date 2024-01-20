import { FC } from 'react';
import { createElement, memo } from 'react';

type HookType<HookProps, HookResult> = (props: HookProps) => HookResult;

type Options = {
  displayName?: string;
};

export function bind<HookProps extends Record<string, unknown>, HookResult extends object>(
  useHook: HookType<HookProps, HookResult>,
  ViewComponent: FC<HookResult>,
  options?: Options
) {
  const { displayName } = options ?? {};

  const MemoizedViewComponent = memo(ViewComponent) as unknown as FC<HookResult>;

  const Component = memo<HookProps>(props =>
    createElement(MemoizedViewComponent as FC<HookResult>, useHook(props))
  ) as unknown as FC<HookProps> & {
    ViewComponent: FC<HookResult>;
  };

  Component.ViewComponent = MemoizedViewComponent;

  if (displayName) {
    Component.displayName = displayName;

    Component.ViewComponent.displayName = `${displayName}View`;
  }

  return Component;
}
