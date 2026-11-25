import type { Logger } from 'pino';
import { AxiosError } from 'axios';
import type {
    InverterControlLimit,
    SupportedControlTypes,
} from '../../coordinator/helpers/inverterController.js';
import type { DerSample } from '../../coordinator/helpers/derSample.js';
import type { Config } from '../../helpers/configSchema.js';
import { env } from '../../helpers/env.js';
import { writeControlLimit } from '../../helpers/influxdb.js';
import { pinoLogger } from '../../helpers/logger.js';
import { numberWithPow10 } from '../../helpers/number.js';
import { sanitizeAxiosError } from '../../helpers/sanitizeAxiosError.js';
import { getSep2Certificate } from '../../helpers/sep2Cert.js';
import type { SiteSample } from '../../meters/siteSample.js';
import { SEP2Client } from '../../sep2/client.js';
import {
    ControlLimitRampHelper,
    type ControlLimitRampTarget,
} from '../../sep2/helpers/controlLimitRamp.js';
import {
    ControlSchedulerHelper,
    type RandomizedControlSchedule,
} from '../../sep2/helpers/controlScheduler.js';
import {
    DerControlsHelper,
    type DerControlsHelperChangedData,
} from '../../sep2/helpers/derControls.js';
import { DerHelper } from '../../sep2/helpers/der.js';
import { DerListHelper } from '../../sep2/helpers/derList.js';
import { DeviceCapabilityHelper } from '../../sep2/helpers/deviceCapability.js';
import { EndDeviceListHelper } from '../../sep2/helpers/endDeviceList.js';
import { FunctionSetAssignmentsListHelper } from '../../sep2/helpers/functionSetAssignmentsList.js';
import { MirrorUsagePointListHelper } from '../../sep2/helpers/mirrorUsagePointList.js';
import { RampRateHelper } from '../../sep2/helpers/rampRate.js';
import { RegistrationHelper } from '../../sep2/helpers/registration.js';
import { TimeHelper } from '../../sep2/helpers/time.js';
import { objectToXml } from '../../sep2/helpers/xml.js';
import { generateConnectionPointResponse } from '../../sep2/models/connectionPoint.js';
import {
    generateEndDeviceResponse,
    parseEndDeviceXml,
} from '../../sep2/models/endDevice.js';
import type { EndDeviceList } from '../../sep2/models/endDeviceList.js';
import type { SetpointType } from '../setpoint.js';
import { RediscoverBackoff } from './rediscoverBackoff.js';

export type CsipAusControlSchedules = Record<
    SupportedControlTypes,
    RandomizedControlSchedule[]
>;

// how long to wait after a 403 before re-running discovery, so a burst of 403s
// from several resources collapses into a single recovery
const rediscoverDebounceMs = 5_000;
// exponential backoff bounds, in case the server will not accept us back yet
const rediscoverMinDelayMs = 5_000;
const rediscoverMaxDelayMs = 300_000;
// how long a recovery must go without another 403 before the backoff resets.
// every resource is polled as soon as discovery reaches it, so a registration
// the server still rejects shows up well within this
const rediscoverHealthyAfterMs = 300_000;

// the helpers that talk to the server's resource graph. They are rebuilt when
// discovery re-runs, while everything holding control state (schedulers,
// DerControlsHelper and ramp helpers) lives for the whole setpoint, so controls
// and their superseded state survive a recovery
type Discovery = {
    abortController: AbortController;
    deviceCapabilityHelper: DeviceCapabilityHelper;
    timeHelper: TimeHelper;
    endDeviceListHelper: EndDeviceListHelper;
    registrationHelper: RegistrationHelper;
    derListHelper: DerListHelper;
    derHelper: DerHelper;
    functionSetAssignmentsListHelper: FunctionSetAssignmentsListHelper;
    mirrorUsagePointListHelper: MirrorUsagePointListHelper;
};

export class CsipAusSetpoint implements SetpointType {
    private schedulerByControlType: {
        [T in SupportedControlTypes]: ControlSchedulerHelper<T>;
    };
    private opModExpLimWRampRateHelper: ControlLimitRampHelper;
    private opModGenLimWRampRateHelper: ControlLimitRampHelper;
    private opModImpLimWRampRateHelper: ControlLimitRampHelper;
    private opModLoadLimWRampRateHelper: ControlLimitRampHelper;
    private logger: Logger;
    private csipAusConfig: NonNullable<Config['setpoints']['csipAus']>;
    private sep2Client: SEP2Client;
    private derControlsHelper: DerControlsHelper;
    private rampRateHelper: RampRateHelper;
    private discovery: Discovery;
    private connected = false;
    private destroyed = false;
    private rediscoverTimer: NodeJS.Timeout | null = null;
    private rediscoverBackoff = new RediscoverBackoff({
        minDelayMs: rediscoverMinDelayMs,
        maxDelayMs: rediscoverMaxDelayMs,
        healthyAfterMs: rediscoverHealthyAfterMs,
    });

    constructor({
        csipAusConfig,
    }: {
        csipAusConfig: NonNullable<Config['setpoints']['csipAus']>;
    }) {
        this.csipAusConfig = csipAusConfig;
        this.logger = pinoLogger.child({ module: 'CsipAusSetpoint' });

        const sep2Certificate = getSep2Certificate();

        this.sep2Client = new SEP2Client({
            host: this.csipAusConfig.host,
            cert: sep2Certificate.cert,
            key: sep2Certificate.key,
            pen: env.SEP2_PEN,
        });

        this.rampRateHelper = new RampRateHelper();

        this.schedulerByControlType = {
            opModExpLimW: new ControlSchedulerHelper({
                client: this.sep2Client,
                controlType: 'opModExpLimW',
            }),
            opModEnergize: new ControlSchedulerHelper({
                client: this.sep2Client,
                controlType: 'opModEnergize',
            }),
            opModConnect: new ControlSchedulerHelper({
                client: this.sep2Client,
                controlType: 'opModConnect',
            }),
            opModGenLimW: new ControlSchedulerHelper({
                client: this.sep2Client,
                controlType: 'opModGenLimW',
            }),
            opModImpLimW: new ControlSchedulerHelper({
                client: this.sep2Client,
                controlType: 'opModImpLimW',
            }),
            opModLoadLimW: new ControlSchedulerHelper({
                client: this.sep2Client,
                controlType: 'opModLoadLimW',
            }),
        };

        this.opModExpLimWRampRateHelper = new ControlLimitRampHelper({
            rampRateHelper: this.rampRateHelper,
        });

        this.opModGenLimWRampRateHelper = new ControlLimitRampHelper({
            rampRateHelper: this.rampRateHelper,
        });

        this.opModImpLimWRampRateHelper = new ControlLimitRampHelper({
            rampRateHelper: this.rampRateHelper,
        });

        this.opModLoadLimWRampRateHelper = new ControlLimitRampHelper({
            rampRateHelper: this.rampRateHelper,
        });

        this.derControlsHelper = new DerControlsHelper({
            client: this.sep2Client,
        }).on('data', (data) => {
            this.logger.debug(data, 'DER controls data changed');

            this.updateSep2ControlsData(data);

            this.rampRateHelper.setDefaultDERControlRampRate(
                data.fallbackControl.type === 'default'
                    ? (data.fallbackControl.data.defaultControl.setGradW ??
                          null)
                    : null,
            );
        });

        // a 403 means the server no longer associates our certificate with our
        // EndDevice registration, so every cached href we hold is dead. Re-run
        // discovery from the device capability document.
        this.sep2Client.on('forbiddenError', (error) => {
            this.scheduleRediscover({
                reason: `${error.config?.method?.toUpperCase() ?? 'request'} ${error.config?.url ?? 'unknown url'} returned 403`,
            });
        });

        this.discovery = this.createDiscovery({ loadFsaCache: true });
        this.startDiscovery(this.discovery);
    }

    private createDiscovery({
        loadFsaCache,
    }: {
        loadFsaCache: boolean;
    }): Discovery {
        const client = this.sep2Client;

        return {
            abortController: new AbortController(),
            timeHelper: new TimeHelper({ client }),
            endDeviceListHelper: new EndDeviceListHelper({ client }),
            registrationHelper: new RegistrationHelper({ client }),
            derListHelper: new DerListHelper({ client }),
            derHelper: new DerHelper({
                client,
                rampRateHelper: this.rampRateHelper,
            }),
            functionSetAssignmentsListHelper:
                new FunctionSetAssignmentsListHelper({
                    client,
                    loadCache: loadFsaCache,
                }),
            mirrorUsagePointListHelper: new MirrorUsagePointListHelper({
                client,
            }),
            deviceCapabilityHelper: new DeviceCapabilityHelper({
                client,
                href: this.csipAusConfig.dcapUri,
            }),
        };
    }

    // attach the listeners that walk the resource graph. They only ever touch
    // this run's helpers, and each checks the run's signal first so a late
    // event or reply from a stopped run cannot restart its destroyed helpers
    // or feed stale data into the shared control state
    private startDiscovery(run: Discovery) {
        const { signal } = run.abortController;
        // read through a function: TypeScript keeps a narrowed signal.aborted
        // across an await, but the run can be stopped while we wait
        const isStopped = () => signal.aborted;

        run.endDeviceListHelper.on('data', (endDeviceList) => {
            if (isStopped()) {
                return;
            }

            void (async () => {
                this.logger.debug(
                    { endDeviceList },
                    'Received SEP2 end device list',
                );

                const endDevice = await this.getOrCreateEndDevice({
                    endDeviceList,
                    signal,
                });

                if (isStopped()) {
                    return;
                }

                if (endDevice.enabled !== true) {
                    throw new Error('End device is not enabled');
                }

                run.mirrorUsagePointListHelper.updateEndDevice({
                    endDevice,
                });

                if (endDevice.derListLink) {
                    run.derListHelper.updateHref({
                        href: endDevice.derListLink.href,
                    });
                }

                if (endDevice.functionSetAssignmentsListLink) {
                    run.functionSetAssignmentsListHelper.updateHref({
                        href: endDevice.functionSetAssignmentsListLink.href,
                    });
                }

                if (endDevice.connectionPointLink?.href) {
                    await this.putConnectionPointId({
                        connectionPointHref: endDevice.connectionPointLink.href,
                        signal,
                    });

                    if (isStopped()) {
                        return;
                    }
                }

                if (endDevice.registrationLink) {
                    run.registrationHelper.updateHref({
                        href: endDevice.registrationLink.href,
                    });
                }
            })().catch((error: unknown) => {
                // a request cancelled by stopping the run is expected
                if (isStopped()) {
                    return;
                }

                // never let a discovery failure become an unhandled rejection,
                // which would take down the process
                this.logger.error(
                    error instanceof AxiosError
                        ? sanitizeAxiosError(error)
                        : error,
                    'Failed to handle SEP2 end device list',
                );
            });
        });

        run.derListHelper.on('data', (derList) => {
            if (isStopped()) {
                return;
            }

            this.logger.debug({ derList }, 'Received SEP2 end device DER list');

            if (derList.ders.length !== 1) {
                this.logger.error(
                    { dersCount: derList.ders.length },
                    'DERS list length is not 1, ignoring DER list',
                );

                return;
            }

            const der = derList.ders.at(0)!;

            run.derHelper.configureDer({
                der,
                pollRate: derList.pollRate,
            });
        });

        run.functionSetAssignmentsListHelper.on(
            'data',
            (functionSetAssignmentsList) => {
                if (isStopped()) {
                    return;
                }

                this.logger.debug(
                    { functionSetAssignmentsList },
                    'Received SEP2 function set assignments list',
                );

                this.derControlsHelper.updateFsaData(
                    functionSetAssignmentsList,
                );
            },
        );

        this.logger.info('Discovering SEP2');

        run.deviceCapabilityHelper
            .on('data', (deviceCapability) => {
                if (isStopped()) {
                    return;
                }

                this.updateConnected(true);

                this.logger.debug(
                    { deviceCapability },
                    'Received SEP2 device capability',
                );

                run.timeHelper.updateHref({
                    href: deviceCapability.timeLink.href,
                });

                run.endDeviceListHelper.updateHref({
                    href: deviceCapability.endDeviceListLink.href,
                });

                run.mirrorUsagePointListHelper.updateHref({
                    href: deviceCapability.mirrorUsagePointListLink.href,
                });
            })
            .on('pollError', () => {
                if (isStopped()) {
                    return;
                }

                this.updateConnected(false);
            });
    }

    private stopDiscovery(run: Discovery) {
        run.abortController.abort();

        run.deviceCapabilityHelper.destroy();
        run.timeHelper.destroy();
        run.endDeviceListHelper.destroy();
        run.registrationHelper.destroy();
        run.derListHelper.destroy();
        run.derHelper.destroy();
        run.functionSetAssignmentsListHelper.destroy();
        run.mirrorUsagePointListHelper.destroy();
    }

    private restartDiscovery() {
        this.updateConnected(false);
        this.stopDiscovery(this.discovery);

        // the FSA disk cache holds the previous registration's data. The
        // controls currently in effect are kept in memory by DerControlsHelper
        // and the schedulers until the server sends fresh data.
        this.discovery = this.createDiscovery({ loadFsaCache: false });
        this.startDiscovery(this.discovery);
    }

    private scheduleRediscover({ reason }: { reason: string }) {
        if (this.destroyed || this.rediscoverTimer) {
            return;
        }

        const delayMs = Math.max(
            this.rediscoverBackoff.getDelayMs(),
            rediscoverDebounceMs,
        );

        this.logger.warn(
            { reason, delayMs },
            'SEP2 server returned 403 Forbidden, scheduling SEP2 re-discovery',
        );

        this.rediscoverTimer = setTimeout(() => {
            this.rediscoverTimer = null;

            if (this.destroyed) {
                return;
            }

            // back off in case the server is not ready to register us again
            this.rediscoverBackoff.onRediscover();

            this.logger.info('Re-running SEP2 discovery');

            this.restartDiscovery();
        }, delayMs);
    }

    getSchedulerByControlType() {
        return this.schedulerByControlType;
    }

    getControlSchedules(): CsipAusControlSchedules {
        return {
            opModExpLimW:
                this.schedulerByControlType.opModExpLimW.getControlSchedules(),
            opModGenLimW:
                this.schedulerByControlType.opModGenLimW.getControlSchedules(),
            opModImpLimW:
                this.schedulerByControlType.opModImpLimW.getControlSchedules(),
            opModLoadLimW:
                this.schedulerByControlType.opModLoadLimW.getControlSchedules(),
            opModEnergize:
                this.schedulerByControlType.opModEnergize.getControlSchedules(),
            opModConnect:
                this.schedulerByControlType.opModConnect.getControlSchedules(),
        };
    }

    getSetGradW(): number {
        return this.rampRateHelper.getDerSettingsSetGradW();
    }

    getStatus() {
        return {
            connected: this.connected,
            lfdi: this.sep2Client.lfdi,
            sfdi: this.sep2Client.sfdi,
        };
    }

    updateSep2ControlsData(data: DerControlsHelperChangedData) {
        for (const scheduler of Object.values(this.schedulerByControlType)) {
            scheduler.updateControlsData(data);
        }
    }

    onDerSample(derSample: DerSample) {
        this.rampRateHelper.onDerSample(derSample);
        this.discovery.derHelper.onDerSample(derSample);
        this.discovery.mirrorUsagePointListHelper.addDerSample(derSample);
    }

    onSiteSample(siteSample: SiteSample) {
        this.discovery.mirrorUsagePointListHelper.addSiteSample(siteSample);
    }

    getInverterControlLimit(): InverterControlLimit {
        const opModExpLimW =
            this.schedulerByControlType.opModExpLimW.getActiveScheduleDerControlBaseValue();

        this.opModExpLimWRampRateHelper.updateTarget(
            ((): ControlLimitRampTarget => {
                switch (opModExpLimW.type) {
                    case 'active':
                    case 'default': {
                        return {
                            type: opModExpLimW.type,
                            value: opModExpLimW.control
                                ? numberWithPow10(
                                      opModExpLimW.control.value,
                                      opModExpLimW.control.multiplier,
                                  )
                                : undefined,
                            rampTimeSeconds: opModExpLimW.rampTms,
                        };
                    }
                    case 'none':
                        return {
                            type: 'none',
                            value: this.csipAusConfig.fixedDefault
                                ?.exportLimitWatts,
                        };
                }
            })(),
        );

        const opModGenLimW =
            this.schedulerByControlType.opModGenLimW.getActiveScheduleDerControlBaseValue();

        this.opModGenLimWRampRateHelper.updateTarget(
            ((): ControlLimitRampTarget => {
                switch (opModGenLimW.type) {
                    case 'active':
                    case 'default': {
                        return {
                            type: opModGenLimW.type,
                            value: opModGenLimW.control
                                ? numberWithPow10(
                                      opModGenLimW.control.value,
                                      opModGenLimW.control.multiplier,
                                  )
                                : undefined,
                            rampTimeSeconds: opModGenLimW.rampTms,
                        };
                    }
                    case 'none':
                        return { type: 'none', value: undefined };
                }
            })(),
        );

        const opModImpLimW =
            this.schedulerByControlType.opModImpLimW.getActiveScheduleDerControlBaseValue();

        this.opModImpLimWRampRateHelper.updateTarget(
            ((): ControlLimitRampTarget => {
                switch (opModImpLimW.type) {
                    case 'active':
                    case 'default': {
                        return {
                            type: opModImpLimW.type,
                            value: opModImpLimW.control
                                ? numberWithPow10(
                                      opModImpLimW.control.value,
                                      opModImpLimW.control.multiplier,
                                  )
                                : undefined,
                            rampTimeSeconds: opModImpLimW.rampTms,
                        };
                    }
                    case 'none':
                        return {
                            type: 'none',
                            value: this.csipAusConfig.fixedDefault
                                ?.importLimitWatts,
                        };
                }
            })(),
        );

        const opModLoadLimW =
            this.schedulerByControlType.opModLoadLimW.getActiveScheduleDerControlBaseValue();

        this.opModLoadLimWRampRateHelper.updateTarget(
            ((): ControlLimitRampTarget => {
                switch (opModLoadLimW.type) {
                    case 'active':
                    case 'default': {
                        return {
                            type: opModLoadLimW.type,
                            value: opModLoadLimW.control
                                ? numberWithPow10(
                                      opModLoadLimW.control.value,
                                      opModLoadLimW.control.multiplier,
                                  )
                                : undefined,
                            rampTimeSeconds: opModLoadLimW.rampTms,
                        };
                    }
                    case 'none':
                        return { type: 'none', value: undefined };
                }
            })(),
        );

        const limit: InverterControlLimit = {
            source: 'csipAus',
            opModExpLimW: this.opModExpLimWRampRateHelper.getRampedValue(),
            opModGenLimW: this.opModGenLimWRampRateHelper.getRampedValue(),
            opModEnergize:
                this.schedulerByControlType.opModEnergize.getActiveScheduleDerControlBaseValue()
                    .control,
            opModConnect:
                this.schedulerByControlType.opModConnect.getActiveScheduleDerControlBaseValue()
                    .control,
            opModImpLimW: this.opModImpLimWRampRateHelper.getRampedValue(),
            opModLoadLimW: this.opModLoadLimWRampRateHelper.getRampedValue(),
        };

        writeControlLimit({ limit });

        return limit;
    }

    private async getOrCreateEndDevice({
        endDeviceList,
        signal,
    }: {
        endDeviceList: EndDeviceList;
        signal: AbortSignal;
    }) {
        // as a direct client, we expect only one end device that matches the LFDI of our certificate
        const endDevice = endDeviceList.endDevices.find(
            (endDevice) =>
                // LFDI should always be uppercase but in case the server returns lowercase
                endDevice.lFDI?.toUpperCase() === this.sep2Client.lfdi &&
                endDevice.enabled === true,
        );

        if (endDevice) {
            return endDevice;
        }

        const endDeviceListHref = endDeviceList.href;
        if (!endDeviceListHref) {
            throw new Error('Missing endDeviceList href');
        }

        return this.postEndDevice({
            endDeviceListHref,
            signal,
        });
    }

    private async postEndDevice({
        endDeviceListHref,
        signal,
    }: {
        endDeviceListHref: string;
        signal: AbortSignal;
    }) {
        const data = generateEndDeviceResponse({
            lFDI: this.sep2Client.lfdi,
            sFDI: this.sep2Client.sfdi,
            changedTime: new Date(),
            enabled: true,
        });
        const xml = objectToXml(data);

        // if stopping the run cancels this, the server may still have created
        // the EndDevice. The next discovery then finds it in the EndDeviceList.
        const response = await this.sep2Client.post(endDeviceListHref, xml, {
            signal,
        });

        const locationHeader = response.headers['location'] as
            | string
            | undefined;

        if (!locationHeader) {
            throw new Error('Missing location header');
        }

        return parseEndDeviceXml(
            await this.sep2Client.get(locationHeader, {
                signal,
            }),
        );
    }

    private async putConnectionPointId({
        connectionPointHref,
        signal,
    }: {
        connectionPointHref: string;
        signal: AbortSignal;
    }) {
        const nmi = this.csipAusConfig.nmi;

        if (!nmi) {
            throw new Error(
                'Missing NMI for CSIP-AUS ConnectionPoint in-band registration',
            );
        }

        const data = generateConnectionPointResponse({
            connectionPointId: nmi,
        });
        const xml = objectToXml(data);

        await this.sep2Client.put(connectionPointHref, xml, { signal });
    }

    destroy(): void {
        this.logger.info('Destroying CSIP-AUS setpoint');
        this.destroyed = true;

        if (this.rediscoverTimer) {
            clearTimeout(this.rediscoverTimer);
            this.rediscoverTimer = null;
        }

        this.sep2Client.removeAllListeners();
        this.stopDiscovery(this.discovery);
        this.derControlsHelper.destroy();
    }

    private updateConnected(connected: boolean) {
        if (this.connected === connected) {
            return;
        }

        this.connected = connected;
        this.logger.info({ connected }, 'CSIP-AUS connected state changed');
    }
}
