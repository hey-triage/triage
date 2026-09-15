/**
 * A thin, styled wrapper around Radix's dropdown-menu — our one menu idiom.
 *
 * Radix owns the hard parts (focus trapping, keyboard nav, collision-aware
 * positioning, click-outside, Escape, submenu timing); we own the pixels via
 * the `uiMenu*` classes in styles.css. Content is portaled to <body>, so the
 * styling here never depends on where the trigger sits in the tree.
 *
 * The portal is a DOM portal only — React still bubbles events through the
 * *component* tree, so a click on a menu item reaches whatever wraps the
 * trigger. Our menus live inside clickable rows (sessions, terminals), so the
 * content swallows click/keydown: picking "Delete" must not also select the
 * row. Item actions run through `onSelect`, which Radix fires itself.
 */
import * as ContextMenu from '@radix-ui/react-context-menu'
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
  onClick,
  onKeyDown,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        className={cx('uiMenu', className)}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        align={align}
        onClick={(e) => {
          onClick?.(e)
          e.stopPropagation()
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          e.stopPropagation()
        }}
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
  onClick,
  onKeyDown,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.SubContent>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent
        className={cx('uiMenu', className)}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        onClick={(e) => {
          onClick?.(e)
          e.stopPropagation()
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          e.stopPropagation()
        }}
        {...props}
      />
    </DropdownMenu.Portal>
  )
}

export function MenuSeparator(props: ComponentPropsWithoutRef<typeof DropdownMenu.Separator>) {
  return <DropdownMenu.Separator className="uiMenuSep" {...props} />
}

/**
 * The same menu, opened by right-click instead of a trigger button. Radix
 * gives us cursor positioning and the long-press gesture; the pixels are the
 * `uiMenu*` classes above, so a context menu looks like every other menu.
 */
export const CtxMenu = ContextMenu.Root
export const CtxMenuTrigger = ContextMenu.Trigger

export function CtxMenuContent({
  className,
  collisionPadding = 8,
  onClick,
  onKeyDown,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenu.Content>) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content
        className={cx('uiMenu', className)}
        collisionPadding={collisionPadding}
        onClick={(e) => {
          onClick?.(e)
          e.stopPropagation()
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          e.stopPropagation()
        }}
        {...props}
      />
    </ContextMenu.Portal>
  )
}

export function CtxMenuItem({ className, ...props }: ComponentPropsWithoutRef<typeof ContextMenu.Item>) {
  return <ContextMenu.Item className={cx('uiMenuItem', className)} {...props} />
}

export function CtxMenuSeparator(props: ComponentPropsWithoutRef<typeof ContextMenu.Separator>) {
  return <ContextMenu.Separator className="uiMenuSep" {...props} />
}
