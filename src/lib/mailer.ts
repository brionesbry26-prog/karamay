/**
 * Outbound email abstraction. Only a development outbox exists today; a real
 * provider adapter must be added before accounts can be enabled in production
 * (see docs/DEPLOYMENT.md, "Email delivery"). Mail bodies and links are never
 * logged because they contain single-use credentials.
 */
export type MailKind = 'verify_registration' | 'already_registered' | 'password_reset' | 'password_changed';

export interface MailMessage {
  to: string;
  kind: MailKind;
  link?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export class DevOutboxMailer implements Mailer {
  readonly outbox: MailMessage[] = [];

  /** echo=true (local development only) prints links to the terminal so sign-up can be completed without a mail server. */
  constructor(private readonly echo = false) {}

  async send(msg: MailMessage): Promise<void> {
    this.outbox.push(msg);
    if (this.outbox.length > 200) this.outbox.shift();
    // Deliberately console, not the app logger: dev-only output that never reaches log shipping.
    if (this.echo) console.log(`[dev-mail] to=${msg.to} kind=${msg.kind}${msg.link ? ` link=${msg.link}` : ''}`);
  }

  lastFor(to: string, kind?: MailKind): MailMessage | undefined {
    return [...this.outbox].reverse().find((m) => m.to === to && (!kind || m.kind === kind));
  }
}

export class DisabledMailer implements Mailer {
  async send(): Promise<void> {
    throw new Error('email delivery is not configured');
  }
}
