// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.4;

import {IVault} from "../../fiat/interfaces/IVault.sol";

interface IVaultFC is IVault {

    function currencyId() external view returns (uint256);

    function tenor() external view returns (uint256);

    function redeemAndExit(
        uint256 tokenId,
        address user,
        uint256 amount
    ) external returns (uint256 redeemed);

    function redeems(
        uint256 tokenId,
        uint256 amount,
        uint256 cTokenExRate
    ) external view returns (uint256);
}
