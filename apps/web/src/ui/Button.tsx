import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

type Common = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  variant?: ButtonVariant;
  small?: boolean;
  icon?: IconName;
};

type WithLabel = Common & { children: ReactNode };
/** Nur-Symbol-Schaltfläche: aria-label ist Pflicht (Design-Guide 11.8). */
type IconOnly = Common & { icon: IconName; "aria-label": string; children?: undefined };

export type ButtonProps = WithLabel | IconOnly;

/** Schaltfläche nach Design-Guide 11.3. Pro Ansicht höchstens eine primäre. */
export function Button({
  variant = "secondary",
  small,
  icon,
  children,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  const cls = [
    "btn",
    `btn--${variant}`,
    small && "btn--sm",
    children === undefined && "btn--icon",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={cls} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
