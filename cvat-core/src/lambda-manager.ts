// Copyright (C) 2019-2022 Intel Corporation
// Copyright (C) 2022-2023 CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import serverProxy from './server-proxy';
import { ArgumentError } from './exceptions';
import MLModel from './ml-model';
import { ModelProviders, RQStatus } from './enums';

export interface ModelProvider {
    name: string;
    icon: string;
    attributes: Record<string, string>;
}

interface ModelProxy {
    run: (body: any) => Promise<any>;
    call: (modelID: string | number, body: any) => Promise<any>;
    status: (requestID: string) => Promise<any>;
    cancel: (requestID: string) => Promise<any>;
}

class LambdaManager {
    private listening: Record<number, {
        onUpdate: ((status: RQStatus, progress: number, message?: string) => void)[];
        functionID: string;
        timeout: number | null;
    }>;
    private cachedList: any;

    constructor() {
        this.listening = {};
        this.cachedList = null;
    }

    async list(): Promise<{ models: MLModel[], count: number }> {
        const lambdaFunctions = await serverProxy.lambda.list();

        const functionsResult = await serverProxy.functions.list();
        const { results: functions, count: functionsCount } = functionsResult;

        const result = [...lambdaFunctions, ...functions];
        const models = result.map((serialzedModel) => new MLModel({ ...serialzedModel }));

        this.cachedList = models;
        return { models, count: lambdaFunctions.length + functionsCount };
    }

    async run(taskID: number, model: MLModel, args: any) {
        if (!Number.isInteger(taskID) || taskID < 0) {
            throw new ArgumentError(`Argument taskID must be a positive integer. Got "${taskID}"`);
        }

        if (!(model instanceof MLModel)) {
            throw new ArgumentError(
                `Argument model is expected to be an instance of MLModel class, but got ${typeof model}`,
            );
        }

        if (args && typeof args !== 'object') {
            throw new ArgumentError(`Argument args is expected to be an object, but got ${typeof model}`);
        }

        const body = {
            ...args,
            task: taskID,
            function: model.id,
        };

        const result = await LambdaManager.getModelProxy(model).run(body);
        return result.id;
    }

    async call(taskID, model, args) {
        if (!Number.isInteger(taskID) || taskID < 0) {
            throw new ArgumentError(`Argument taskID must be a positive integer. Got "${taskID}"`);
        }

        const body = {
            ...args,
            task: taskID,
        };

        const result = await LambdaManager.getModelProxy(model).call(model.id, body);
        return result;
    }

    async requests() {
        const lambdaRequests = await serverProxy.lambda.requests();
        const functionsRequests = await serverProxy.functions.requests();
        const result = [...lambdaRequests, ...functionsRequests];
        return result.filter((request) => ['queued', 'started'].includes(request.status));
    }

    async cancel(requestID, functionID): Promise<void> {
        if (typeof requestID !== 'string') {
            throw new ArgumentError(`Request id argument is required to be a string. But got ${requestID}`);
        }
        const model = this.cachedList.find((_model) => _model.id === functionID);
        if (!model) {
            throw new ArgumentError('Incorrect Function Id provided');
        }

        if (this.listening[requestID]) {
            clearTimeout(this.listening[requestID].timeout);
            delete this.listening[requestID];
        }

        await LambdaManager.getModelProxy(model).cancel(requestID);
    }

    async listen(
        requestID: string,
        functionID: string,
        callback: (status: RQStatus, progress: number, message?: string) => void,
    ): Promise<void> {
        const model = this.cachedList.find((_model) => _model.id === functionID);
        if (!model) {
            throw new ArgumentError('Incorrect function Id provided');
        }

        if (requestID in this.listening) {
            this.listening[requestID].onUpdate.push(callback);
            // already listening, avoid sending extra requests
            return;
        }

        const timeoutCallback = (): void => {
            LambdaManager.getModelProxy(model).status(requestID).then((response) => {
                const { status } = response;
                if (requestID in this.listening) {
                    // check it was not cancelled
                    const { onUpdate } = this.listening[requestID];
                    if ([RQStatus.QUEUED, RQStatus.STARTED].includes(status)) {
                        onUpdate.forEach((update) => update(status, response.progress || 0));
                        this.listening[requestID].timeout = window
                            .setTimeout(timeoutCallback, status === RQStatus.QUEUED ? 30000 : 10000);
                    } else {
                        delete this.listening[requestID];
                        if (status === RQStatus.FINISHED) {
                            onUpdate
                                .forEach((update) => update(status, response.progress || 100));
                        } else {
                            onUpdate
                                .forEach((update) => update(status, response.progress || 0, response.exc_info || ''));
                        }
                    }
                }
            }).catch((error) => {
                if (requestID in this.listening) {
                    // check it was not cancelled
                    const { onUpdate } = this.listening[requestID];
                    onUpdate
                        .forEach((update) => update(
                            RQStatus.UNKNOWN,
                            0,
                            `Could not get a status of the request ${requestID}. ${error.toString()}`,
                        ));
                }
            }).finally(() => {
                if (requestID in this.listening) {
                    this.listening[requestID].timeout = null;
                }
            });
        };

        this.listening[requestID] = {
            onUpdate: [callback],
            functionID,
            timeout: window.setTimeout(timeoutCallback),
        };
    }

    async providers(): Promise<ModelProvider[]> {
        const providersData: Record<string, Record<string, string>> = await serverProxy.functions.providers();
        const providers = Object.entries(providersData).map(([provider, attributes]) => {
            const { icon } = attributes;
            delete attributes.icon;
            return {
                name: provider,
                icon,
                attributes,
            };
        });
        return providers;
    }

    private static getModelProxy(model: MLModel): ModelProxy {
        return model.provider === ModelProviders.CVAT ? serverProxy.lambda : serverProxy.functions;
    }
}

export default new LambdaManager();
