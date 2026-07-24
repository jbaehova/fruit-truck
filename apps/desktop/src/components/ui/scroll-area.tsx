import type { Ref } from "react";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { cn } from "@/lib/utils";

type Props = ScrollAreaPrimitive.Root.Props & {
  viewportRef?: Ref<HTMLDivElement>;
  viewportClassName?: string;
  contentClassName?: string;
};

function ScrollArea({
  className,
  viewportRef,
  viewportClassName,
  contentClassName,
  children,
  ...props
}: Props) {
  return (
    <ScrollAreaPrimitive.Root className={cn("base-scroll-area", className)} {...props}>
      <ScrollAreaPrimitive.Viewport ref={viewportRef} className={cn("base-scroll-viewport", viewportClassName)}>
        <ScrollAreaPrimitive.Content className={cn("base-scroll-content", contentClassName)}>
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar className="base-scrollbar">
        <ScrollAreaPrimitive.Thumb className="base-scroll-thumb" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner className="base-scroll-corner" />
    </ScrollAreaPrimitive.Root>
  );
}

export { ScrollArea };
