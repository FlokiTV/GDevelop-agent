// @flow
import * as React from 'react';
import {
  type AssetSearchAndInstallOptions,
  type AssetSearchAndInstallResult,
} from '../EditorFunctions';
import AuthenticatedUserContext from '../Profile/AuthenticatedUserContext';
import {
  createAssetSearch,
  type AssetSearch,
} from '../Utils/GDevelopServices/Generation';
import { retryIfFailed } from '../Utils/RetryIfFailed';
import { useInstallAsset } from '../AssetStore/NewObjectDialog';
import { type ResourceManagementProps } from '../ResourcesList/ResourceSource';
import { AssetStoreContext } from '../AssetStore/AssetStoreContext';
import { listAllPublicAssets } from '../Utils/GDevelopServices/Asset';

type _FuncReturnType = {
  searchAndInstallAsset: AssetSearchAndInstallOptions => Promise<AssetSearchAndInstallResult>,
};

export const useSearchAndInstallAsset = ({
  project,
  resourceManagementProps,
  onWillInstallExtension,
  onExtensionInstalled,
}: {|
  project: ?gdProject,
  resourceManagementProps: ResourceManagementProps,
  onWillInstallExtension: (extensionNames: Array<string>) => void,
  onExtensionInstalled: (extensionNames: Array<string>) => void,
|}): _FuncReturnType => {
  const { profile, getAuthorizationHeader } = React.useContext(
    AuthenticatedUserContext
  );
  const { getAssetShortHeaderFromId, environment } = React.useContext(
    AssetStoreContext
  );
  const installAsset = useInstallAsset({
    project,
    resourceManagementProps,
    onWillInstallExtension,
    onExtensionInstalled,
  });

  return {
    searchAndInstallAsset: React.useCallback(
      async ({
        objectsContainer,
        objectName,
        objectType,
        exactOrPartialAssetId,
        ...assetSearchOptions
      }: AssetSearchAndInstallOptions): Promise<AssetSearchAndInstallResult> => {
        let assetShortHeader;
        if (exactOrPartialAssetId) {
          // Resolve an exact public asset id without requiring the generation
          // service. The in-memory Asset Store catalog is preferred; if it is
          // not warm yet, load the same public catalog used by the editor.
          let foundAssetShortHeader = getAssetShortHeaderFromId(
            exactOrPartialAssetId
          );
          if (!foundAssetShortHeader) {
            try {
              const { publicAssetShortHeaders } = await listAllPublicAssets({
                environment,
              });
              foundAssetShortHeader = publicAssetShortHeaders.find(
                header => header.id === exactOrPartialAssetId
              );
            } catch (error) {
              // Keep backward-compatible behavior: a failed public-catalog
              // lookup can still fall through to the authenticated semantic
              // search below when a profile is available.
              console.warn(
                'Unable to resolve public asset id from the Asset API:',
                error
              );
            }
          }
          if (foundAssetShortHeader) {
            if (objectType && foundAssetShortHeader.objectType !== objectType) {
              return {
                status: 'nothing-found',
                message: `Asset with id "${exactOrPartialAssetId}" has type "${
                  foundAssetShortHeader.objectType
                }", which does not match the requested type "${objectType}".`,
                createdObjects: [],
                assetShortHeader: null,
                isTheFirstOfItsTypeInProject: false,
              };
            }
            assetShortHeader = foundAssetShortHeader;
          }
          // If not found by exact public id, fall through to the search below.
        }

        if (!assetShortHeader) {
          if (!assetSearchOptions.searchTerms && !exactOrPartialAssetId) {
            return {
              status: 'error',
              message:
                'Cannot search for an asset without either `searchTerms` or `exactOrPartialAssetId`.',
              createdObjects: [],
              assetShortHeader: null,
              isTheFirstOfItsTypeInProject: false,
            };
          }
          if (!profile) throw new Error('User should be authenticated.');
          const assetSearch: AssetSearch = await retryIfFailed(
            { times: 3, backoff: { initialDelay: 300, factor: 2 } },
            () =>
              createAssetSearch(getAuthorizationHeader, {
                userId: profile.id,
                objectType,
                exactOrPartialAssetId,
                ...assetSearchOptions,
              })
          );
          if (!assetSearch.results || assetSearch.results.length === 0) {
            return {
              status: 'nothing-found',
              message: 'No assets found.',
              createdObjects: [],
              assetShortHeader: null,
              isTheFirstOfItsTypeInProject: false,
            };
          }

          // In the future, we could ask the user to select the asset they want to use.
          // For now, we just return the first asset.
          const chosenResult = assetSearch.results[0];
          if (!chosenResult) throw new Error('No asset found.');
          assetShortHeader = chosenResult.asset;
        }

        // `installAsset` computes `isTheFirstOfItsTypeInProject` before
        // actually inserting the objects into the project, so it reflects
        // the state right before installation.
        const installOutput = await installAsset({
          assetShortHeader,
          objectsContainer,
          requestedObjectName: objectName,
          setIsAssetBeingInstalled: () => {},
        });

        if (!installOutput) {
          return {
            status: 'error',
            message: 'Asset found but failed to install asset.',
            createdObjects: [],
            assetShortHeader: null,
            isTheFirstOfItsTypeInProject: false,
          };
        }

        return {
          status: 'asset-installed',
          message: 'Asset installed successfully.',
          createdObjects: installOutput.createdObjects,
          assetShortHeader,
          isTheFirstOfItsTypeInProject:
            installOutput.isTheFirstOfItsTypeInProject,
        };
      },
      [
        installAsset,
        profile,
        getAuthorizationHeader,
        getAssetShortHeaderFromId,
        environment,
      ]
    ),
  };
};
