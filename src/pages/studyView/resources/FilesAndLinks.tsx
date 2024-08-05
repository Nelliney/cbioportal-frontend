import * as React from 'react';
import {
    Column,
    default as LazyMobXTable,
} from 'shared/components/lazyMobXTable/LazyMobXTable';
import { observer } from 'mobx-react';
import _ from 'lodash';
import internalClient from 'shared/api/cbioportalInternalClientInstance';
import { Else, If, Then } from 'react-if';
import { WindowWidthBox } from '../../../shared/components/WindowWidthBox/WindowWidthBox';
import LoadingIndicator from 'shared/components/loadingIndicator/LoadingIndicator';
import {
    getSampleViewUrlWithPathname,
    getPatientViewUrlWithPathname,
} from 'shared/api/urls';
import { getAllClinicalDataByStudyViewFilter } from '../StudyViewUtils';
import { StudyViewPageStore } from 'pages/studyView/StudyViewPageStore';
import { isUrl, remoteData } from 'cbioportal-frontend-commons';
import { makeObservable, observable, computed } from 'mobx';
import { ResourceData, StudyViewFilter } from 'cbioportal-ts-api-client';

export interface IFilesLinksTable {
    store: StudyViewPageStore;
}

class FilesLinksTableComponent extends LazyMobXTable<{
    [id: string]: string | number;
}> {}

const RECORD_LIMIT = 500;

async function fetchResourceDataOfPatient(patientIds: Map<string, string>) {
    const ret: { [key: string]: ResourceData[] } = {};
    const promises = [];
    for (let [patientId, studyId] of patientIds) {
        promises.push(
            internalClient
                .getAllResourceDataOfPatientInStudyUsingGET({
                    studyId: studyId,
                    patientId: patientId,
                    projection: 'DETAILED',
                })
                .then(data => {
                    if (patientId in ret) {
                        ret[patientId].push(...data);
                    } else {
                        ret[patientId] = data;
                    }
                })
        );
    }

    return Promise.all(promises).then(() => ret);
}

async function fetchFilesLinksData(
    filters: StudyViewFilter,
    sampleIdResourceData: { [sampleId: string]: ResourceData[] },
    searchTerm: string | undefined,
    sortAttributeId: string | undefined,
    sortDirection: 'asc' | 'desc' | undefined,
    recordLimit: number
) {
    const sampleClinicalDataResponse = await getAllClinicalDataByStudyViewFilter(
        filters,
        searchTerm,
        sortAttributeId,
        sortDirection,
        recordLimit,
        0
    );

    // get unique patient Ids from clinical data to get their resources
    // via fetchResourceDataOfPatient.
    const patientIds = new Map<string, string>();
    _.forEach(sampleClinicalDataResponse.data, data => {
        _.forEach(data, item => {
            patientIds.set(item.patientId, item.studyId);
        });
    });

    // get all resources for patients.
    // improvement: use one request for getting a page of patients
    // with their samples and resources.
    const resourcesForPatients = await fetchResourceDataOfPatient(patientIds);
    const buildItemsAndResources = (resourceData: {
        [key: string]: ResourceData[];
    }) => {
        const resourcesPerPatient: { [key: string]: number } = {};
        const items: { [attributeId: string]: string | number }[] = [];
        _.forEach(resourceData, (data: ResourceData[]) => {
            _.forEach(data, (resource: ResourceData) => {
                items.push({
                    studyId: resource.studyId,
                    patientId: resource.patientId,
                    sampleId: resource.sampleId,
                    resourcesPerPatient: 0,
                    typeOfResource: resource?.resourceDefinition?.displayName,
                    description: resource?.resourceDefinition?.description,
                    url: resource?.url,
                } as { [attributeId: string]: string | number });
            });

            if (data && data.length > 0) {
                if (!(data[0].patientId in resourcesPerPatient))
                    resourcesPerPatient[data[0].patientId] = 0;

                resourcesPerPatient[data[0].patientId] += data.length;
            }
        });

        return { resourcesPerPatient, items };
    };

    const resourcesForPatientsAndSamples: { [key: string]: ResourceData[] } = {
        ...sampleIdResourceData,
        ...resourcesForPatients,
    };

    // we create objects with the necessary properties for each resource
    // calculate the total number of resources per patient.
    const { resourcesPerPatient, items } = buildItemsAndResources(
        resourcesForPatientsAndSamples
    );

    // set the number of resources available per patient.
    _.forEach(items, item => {
        item.resourcesPerPatient = resourcesPerPatient[item.patientId];
    });

    // there is a requirement to sort initially by 'resourcesPerPatient' field
    // in descending order.
    const sortedData = _.orderBy(items, 'resourcesPerPatient', 'desc');
    return {
        totalItems: sortedData.length,
        data: _.values(sortedData),
    };
}

@observer
export class FilesAndLinks extends React.Component<IFilesLinksTable, {}> {
    constructor(props: IFilesLinksTable) {
        super(props);
        makeObservable(this);
    }

    getDefaultColumnConfig(
        key: string,
        columnName: string,
        isNumber?: boolean
    ) {
        return {
            name: columnName || '',
            headerRender: (data: string) => (
                <span data-test={data}>{data}</span>
            ),
            render: (data: { [id: string]: string }) => {
                if (isUrl(data[key])) {
                    return (
                        <a href={data[key]} target="_blank">
                            {data[key]}
                        </a>
                    );
                }
                return <span data-test={data[key]}>{data[key]}</span>;
            },
            download: (data: { [id: string]: string }) => data[key] || '',
            sortBy: (data: { [id: string]: any }) => {
                if (data[key]) {
                    return data[key];
                }
                return null;
            },
            filter: (
                data: { [id: string]: string },
                filterString: string,
                filterStringUpper: string
            ) => {
                if (data[key]) {
                    if (!isNumber) {
                        return (data[key] || '')
                            .toUpperCase()
                            .includes(filterStringUpper);
                    }
                }

                return false;
            },
        };
    }

    @observable searchTerm: string | undefined = undefined;

    readonly resourceData = remoteData({
        await: () => [
            this.props.store.selectedSamples,
            this.props.store.resourceDefinitions,
            this.props.store.sampleResourceData,
        ],
        onError: () => {},
        invoke: async () => {
            if (this.props.store.selectedSamples.result.length === 0) {
                return Promise.resolve({ totalItems: 0, data: [] });
            }
            const resources = await fetchFilesLinksData(
                this.props.store.filters,
                this.props.store.sampleResourceData.result!,
                this.searchTerm,
                'patientId',
                'asc',
                RECORD_LIMIT
            );

            return Promise.resolve(resources);
        },
    });

    @computed get columns() {
        let defaultColumns: Column<{ [id: string]: any }>[] = [
            {
                ...this.getDefaultColumnConfig('patientId', 'Patient ID'),
                render: (data: { [id: string]: string }) => {
                    return (
                        <a
                            href={getPatientViewUrlWithPathname(
                                data.studyId,
                                data.patientId,
                                'patient/filesAndLinks'
                            )}
                            target="_blank"
                        >
                            {data.patientId}
                        </a>
                    );
                },
            },

            {
                ...this.getDefaultColumnConfig('sampleId', 'Sample ID'),
                render: (data: { [id: string]: string }) => {
                    return (
                        <a
                            href={getSampleViewUrlWithPathname(
                                data.studyId,
                                data.sampleId,
                                'patient/filesAndLinks'
                            )}
                            target="_blank"
                        >
                            {data.sampleId}
                        </a>
                    );
                },
            },

            {
                ...this.getDefaultColumnConfig(
                    'typeOfResource',
                    'Type Of Resource'
                ),
                render: (data: { [id: string]: string }) => {
                    return (
                        <div>
                            <a href={data.url} target="_blank">
                                <i
                                    className={`fa fa-external-link fa-sm`}
                                    style={{
                                        marginRight: 5,
                                        color: 'black',
                                        fontSize: 10,
                                    }}
                                />
                                {data.typeOfResource}
                            </a>
                        </div>
                    );
                },
            },

            {
                ...this.getDefaultColumnConfig('description', 'Description'),
                render: (data: { [id: string]: string }) => {
                    return <div>{data.description}</div>;
                },
            },

            {
                ...this.getDefaultColumnConfig(
                    'resourcesPerPatient',
                    'Number of Resource Per Patient',
                    true
                ),
                render: (data: { [id: string]: number }) => {
                    return <div>{data.resourcesPerPatient}</div>;
                },
            },
        ];

        return defaultColumns;
    }

    public render() {
        return (
            <span data-test="files-links-data-content">
                <WindowWidthBox offset={60}>
                    <If condition={this.resourceData.isPending}>
                        <Then>
                            <LoadingIndicator
                                isLoading={true}
                                size={'big'}
                                center={true}
                            />
                        </Then>
                        <Else>
                            <FilesLinksTableComponent
                                initialItemsPerPage={20}
                                headerComponent={
                                    <div className={'positionAbsolute'}>
                                        <strong>
                                            {
                                                this.resourceData.result
                                                    ?.totalItems
                                            }{' '}
                                            resources
                                        </strong>
                                    </div>
                                }
                                data={this.resourceData.result?.data || []}
                                columns={this.columns}
                                showColumnVisibility={false}
                                showCountHeader={false}
                                showFilterClearButton={false}
                                showCopyDownload={false}
                                initialSortColumn={'resourcesPerPatient'}
                                initialSortDirection={'desc'}
                            />
                        </Else>
                    </If>
                </WindowWidthBox>
            </span>
        );
    }
}
