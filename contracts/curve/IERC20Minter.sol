pragma solidity ^0.7.3;

import "../balancer-core-v2/lib/openzeppelin/IERC20.sol";

// Extension of the erc20 interface used for curve lp tokens
// Curve lp tokens have a minter function that is not on the generic ERC20 interface
interface IERC20Minter is IERC20 {
    function minter() external view returns(address);
}