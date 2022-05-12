// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.4;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

import {ICodex} from "../../fiat/interfaces/ICodex.sol";
import {IVault} from "../../fiat/interfaces/IVault.sol";
import {IMoneta} from "../../fiat/interfaces/IMoneta.sol";
import {IFIAT} from "../../fiat/interfaces/IFIAT.sol";
import {WAD, toInt256, wmul} from "../../fiat/utils/Math.sol";

import {VaultActions} from "./VaultActions.sol";

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// WARNING: These functions meant to be used as a a library for a PRBProxy. Some are unsafe if you call them directly.
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

/// @title Vault1155Actions
/// @notice A set of vault actions for modifying positions collateralized by ERC1155 tokens
contract Vault1155Actions is VaultActions {
    /// ======== Custom Errors ======== ///

    error Vault1155Actions__enterVault_zeroVaultAddress();
    error Vault1155Actions__enterVault_zeroTokenAddress();
    error Vault1155Actions__exitVault_zeroVaultAddress();
    error Vault1155Actions__exitVault_zeroToAddress();
    error Vault1155Actions__exitVault_zeroTokenAddress();

    constructor(
        address codex_,
        address moneta_,
        address fiat_,
        address publican_
    ) VaultActions(codex_, moneta_, fiat_, publican_) {}

    /// @notice Deposits amount of `token` with `tokenId` from `from` into the `vault`
    /// @dev Implements virtual method defined in VaultActions for ERC1155 tokens
    /// @param vault Address of the Vault to enter
    /// @param token Address of the collateral token
    /// @param tokenId ERC1155 TokenId
    /// @param from Address from which to take the deposit from
    /// @param amount Amount of collateral tokens to deposit [tokenScale]
    function enterVault(
        address vault,
        address token,
        uint256 tokenId,
        address from,
        uint256 amount
    ) public virtual override {
        if (vault == address(0)) revert Vault1155Actions__enterVault_zeroVaultAddress();
        if (token == address(0)) revert Vault1155Actions__enterVault_zeroTokenAddress();

        // if `from` is set to an external address then transfer amount to the proxy first
        // requires `from` to have set an allowance for the proxy
        if (from != address(0) && from != address(this)) {
            IERC1155(token).safeTransferFrom(from, address(this), tokenId, amount, new bytes(0));
        }

        IERC1155(token).setApprovalForAll(address(vault), true);
        IVault(vault).enter(tokenId, address(this), amount);
    }

    /// @notice Withdraws amount of `token` with `tokenId` to `to` from the `vault`
    /// @dev Implements virtual method defined in VaultActions for ERC1155 tokens
    /// @param vault Address of the Vault to exit
    /// @param token Address of the collateral token
    /// @param tokenId ERC1155 TokenId
    /// @param to Address which receives the withdrawn collateral tokens
    /// @param amount Amount of collateral tokens to exit [tokenScale]
    function exitVault(
        address vault,
        address token,
        uint256 tokenId,
        address to,
        uint256 amount
    ) public virtual override {
        if (vault == address(0)) revert Vault1155Actions__exitVault_zeroVaultAddress();
        if (token == address(0)) revert Vault1155Actions__exitVault_zeroTokenAddress();
        if (to == address(0)) revert Vault1155Actions__exitVault_zeroToAddress();

        IVault(vault).exit(tokenId, to, amount);
    }
}
