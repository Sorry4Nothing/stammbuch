import { Component, useState, type ReactNode } from "react";
import { t } from "../i18n";
import { ErrorState, Message, PageHeader, newErrorId } from "../ui";

interface Props {
  children: ReactNode;
  /** Titel des Tabs: steht als h1 über der Fehlermeldung. */
  title: string;
  /** Wird bei jedem Fehler aufgerufen, z. B. zum Protokollieren. Nie Eingaben mitschicken. */
  onError?: (error: Error, errorId: string) => void;
}

interface State {
  error: Error | null;
  errorId: string;
  at: Date;
}

class Boundary extends Component<Props & { onRetry: () => void }, State> {
  override state: State = { error: null, errorId: "", at: new Date() };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, errorId: newErrorId(), at: new Date() };
  }

  override componentDidCatch(error: Error) {
    this.props.onError?.(error, this.state.errorId);
  }

  override render() {
    const { error, errorId, at } = this.state;
    const { title } = this.props;
    if (!error) return this.props.children;
    return (
      <div className="page">
        <PageHeader title={title} />
        <div className="state-page__alert">
          <Message tone="error" title={t("error.view.alertTitle", { title })}>
            {t("error.view.alertText")}
          </Message>
        </div>
        <ErrorState
          // Die technische Meldung des Fehlers bleibt in der Konsole, nicht auf dem Bildschirm.
          message={t("error.view.message")}
          at={at}
          errorId={errorId}
          onRetry={() => {
            this.setState({ error: null });
            this.props.onRetry();
          }}
        />
      </div>
    );
  }
}

/** Fängt Darstellungsfehler eines Tabs ab, damit die übrigen Tabs und ihre Eingaben erhalten bleiben (Design 2.6). */
export function TabErrorBoundary({ children, title, onError }: Props) {
  // Ein neuer key mountet den Inhalt nach «Erneut laden» frisch.
  const [attempt, setAttempt] = useState(0);
  return (
    <Boundary
      key={attempt}
      title={title}
      onError={onError}
      onRetry={() => setAttempt((n) => n + 1)}
    >
      {children}
    </Boundary>
  );
}
