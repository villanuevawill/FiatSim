// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.4;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

import {IVault} from "../../fiat/interfaces/IVault.sol";
import {wmul} from "../../fiat/utils/Math.sol";

import {VaultActions} from "./VaultActions.sol";

interface IVaultSY {
    function wrap(uint256 bondId, address to) external returns (uint256);

    function unwrap(uint256 bondId, address to) external;

    function unwrap(
        uint256 bondId,
        address to,
        uint256 amount
    ) external;
}

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// WARNING: These functions meant to be used as a a library for a PRBProxy. Some are unsafe if you call them directly.
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

/// @title VaultSYActions
/// @notice A set of vault actions for modifying positions collateralized by BarnBridge Smart Yield senior bonds
contract VaultSYActions is VaultActions {
    /// ======== Custom Errors ======== ///
    error VaultSYActions__enterVault_zeroVaultAddress();
    error VaultSYActions__enterVault_zeroTokenAddress();
    error VaultSYActions__exitVault_zeroVaultAddress();
    error VaultSYActions__exitVault_zeroToAddress();

    constructor(
        address codex_,
        address moneta_,
        address fiat_,
        address publican_
    ) VaultActions(codex_, moneta_, fiat_, publican_) {}

    /// @notice Deposits amount of `token` with `tokenId` from `from` into the `vault`
    /// @dev Implements virtual method defined in VaultActions for ERC721 tokens
    function enterVault(
        address vault,
        address token,
        uint256 tokenId,
        address from,
        uint256 amount
    ) public override {
        if (vault == address(0)) revert VaultSYActions__enterVault_zeroVaultAddress();
        if (token == address(0)) revert VaultSYActions__enterVault_zeroTokenAddress();

        // if `from` is set to an external address then transfer amount to the proxy first
        // requires `from` to have set an allowance for the proxy
        if (from != address(0) && from != address(this)) {
            IERC721(token).safeTransferFrom(msg.sender, address(this), tokenId);
        }

        IERC721(token).approve(vault, tokenId);
        IVaultSY(vault).wrap(tokenId, address(this));

        IERC1155(vault).setApprovalForAll(vault, true);
        IVault(vault).enter(tokenId, address(this), amount);
    }

    /// @notice Withdraws amount of `token` with `tokenId` to `to` from the `vault`
    /// @dev Implements virtual method defined in VaultActions for ERC20 tokens
    function exitVault(
        address vault,
        address, /* token */
        uint256 tokenId,
        address to,
        uint256 amount
    ) public override {
        if (vault == address(0)) revert VaultSYActions__exitVault_zeroVaultAddress();
        if (to == address(0)) revert VaultSYActions__exitVault_zeroToAddress();

        IVault(vault).exit(tokenId, address(this), amount);
        uint256 maturity = IVault(vault).maturity(tokenId);

        if (block.timestamp >= maturity) {
            IVaultSY(vault).unwrap(tokenId, to, amount);
        } else {
            IVaultSY(vault).unwrap(tokenId, to);
        }
    }
}
