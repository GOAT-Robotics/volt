import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background,color,box-shadow,border] duration-100 disabled:pointer-events-none disabled:opacity-45 select-none [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:brightness-110 shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]",
        secondary: "bg-panel border border-border text-fg hover:bg-hover shadow-[0_1px_1px_rgb(0_0_0/0.03)]",
        ghost: "text-muted hover:bg-hover hover:text-fg",
        danger: "bg-danger text-white hover:brightness-110",
        "danger-ghost": "text-danger hover:bg-danger-soft",
        link: "text-accent hover:underline px-0 h-auto",
        tool: "text-muted hover:bg-hover hover:text-fg data-[active=true]:bg-accent-soft data-[active=true]:text-accent",
      },
      size: {
        xs: "h-6 px-2 text-2xs",
        sm: "h-7 px-2.5 text-xs",
        md: "h-8 px-3 text-sm",
        lg: "h-9 px-4 text-sm",
        icon: "size-7",
        "icon-sm": "size-6",
      },
    },
    defaultVariants: { variant: "secondary", size: "sm" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  active?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, active, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp ref={ref} data-active={active ? "true" : undefined} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
Button.displayName = "Button";
