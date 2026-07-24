import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
type ButtonSize = "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";

const baseClass = "base-button";

const variantClasses: Record<ButtonVariant, string> = {
  default: "base-button--default",
  outline: "base-button--outline",
  secondary: "base-button--secondary",
  ghost: "base-button--ghost",
  destructive: "base-button--destructive",
  link: "base-button--link",
};

const sizeClasses: Record<ButtonSize, string> = {
  default: "base-button--size-default",
  xs: "base-button--size-xs",
  sm: "base-button--size-sm",
  lg: "base-button--size-lg",
  icon: "base-button--size-icon",
  "icon-xs": "base-button--size-icon-xs",
  "icon-sm": "base-button--size-icon-sm",
  "icon-lg": "base-button--size-icon-lg",
};

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(baseClass, variantClasses[variant], sizeClasses[size], className)}
      {...props}
    />
  );
}

export { Button };
