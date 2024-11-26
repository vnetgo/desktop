import * as Sentry from '@sentry/electron/main';
import { SENTRY_URL_ENDPOINT } from '../constants';
import { ComfyDesktopApp } from '../main-process/comfyDesktopApp';
import { app, dialog } from 'electron';

class SentryLogging {
  comfyDesktopApp: ComfyDesktopApp | undefined;

  init() {
    Sentry.init({
      dsn: SENTRY_URL_ENDPOINT,
      autoSessionTracking: false,
      enabled: process.env.SENTRY_ENABLED === 'true' || app.isPackaged,
      beforeSend: async (event) => {
        this.filterEvent(event);

        if (
          event.extra?.comfyUIExecutionError ||
          this.comfyDesktopApp?.comfySettings.get('Comfy-Desktop.SendStatistics')
        ) {
          return event;
        }

        const { response } = await dialog.showMessageBox({
          title: 'Send Crash Statistics',
          message: `Would you like to send crash statistics to the team?`,
          buttons: ['Always send crash reports', 'Do not send crash report'],
        });

        return response === 0 ? event : null;
      },
      integrations: [
        Sentry.childProcessIntegration({
          breadcrumbs: ['abnormal-exit', 'killed', 'crashed', 'launch-failed', 'oom', 'integrity-failure'],
          events: ['abnormal-exit', 'killed', 'crashed', 'launch-failed', 'oom', 'integrity-failure'],
        }),
      ],
    });
  }

  private filterEvent(obj: unknown) {
    if (!obj || !this.comfyDesktopApp?.basePath) return obj;

    if (typeof obj === 'string') {
      return obj.replaceAll(this.comfyDesktopApp.basePath, '[basePath]');
    }

    try {
      if (typeof obj === 'object') {
        for (const k in obj) {
          try {
            const record = obj as Record<string, unknown>;
            record[k] = this.filterEvent(record[k]);
          } catch (error) {
            // Failed to read/write key
          }
        }
      }
    } catch (error) {
      // Failed to enumerate keys
    }

    return obj;
  }
}

export default new SentryLogging();