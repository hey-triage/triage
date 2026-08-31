/**
 * A thin, styled wrapper around Radix's dropdown-menu — our one menu idiom.
 *
 * Radix owns the hard parts (focus trapping, keyboard nav, collision-aware
 * positioning, click-outside, Escape, submenu timing); we own the pixels via
 * the `uiMenu*` classes in styles.css. Content is portaled to <body>, so the
 * styling here never depends on where the trigger sits in the tree.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ComponentPropsWithoutRef } from 'react'

function cx(base: string, extra?: string) {
  return extra ? `${base} ${extra}` : base
}

export const Menu = DropdownMenu.Root
export const MenuTrigger = DropdownMenu.Trigger
export const MenuSub = DropdownMenu.Sub

export function MenuContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  align = 'start',
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        className={cx('uiMenu', className)}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        align={align}
        {...props}
      />
    </DropdownMenu.Portal>
  )
}

export function MenuItem({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenu.Item>) {
  return <DropdownMenu.Item className={cx('uiMenuItem', className)} {...props} />
}

export function MenuSubTrigger({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.SubTrigger>) {
  return <DropdownMenu.SubTrigger className={cx('uiMenuItem uiMenuSubTrigger', className)} {...props} />
}

export function MenuSubContent({
  className,
  sideOffset = 4,
  collisionPadding = 8,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.SubContent>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent
        className={cx('uiMenu', className)}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        {...props}
      />
    </DropdownMenu.Portal>
  )
}

export function MenuSeparator(props: ComponentPropsWithoutRef<typeof DropdownMenu.Separator>) {
  return <DropdownMenu.Separator className="uiMenuSep" {...props} />
}
